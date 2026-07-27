import { AppError } from '../../lib/errors.js';
import type { PlatformProviderConfig } from './credentials.js';
import {
  normalizeProviderError,
  type ModelGateway,
  type ProviderStreamInput
} from './model-gateway.js';

export interface OfficialProviderTarget {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  timeoutMs: number;
}

export type OfficialGenerationInput = Omit<
  ProviderStreamInput,
  'provider' | 'model' | 'baseUrl' | 'apiKey'
>;

export interface OfficialProviderAttempt {
  provider: string;
  model: string;
  status: 'COMPLETED' | 'FAILED';
  latencyMs: number;
  errorCode?: string;
}

export interface OfficialCompletionMetadata {
  provider: string;
  model: string;
  providerRequestId?: string;
  fallbackUsed: boolean;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
  attempts: OfficialProviderAttempt[];
}

export interface OfficialCompletionResult extends OfficialCompletionMetadata {
  text: string;
}

export interface OfficialStreamResult {
  textStream: AsyncIterable<string>;
  completion: Promise<OfficialCompletionMetadata>;
}

interface ProviderResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  providerRequestId?: string;
  latencyMs: number;
}

interface ProviderStreamExecution {
  textStream: AsyncIterable<string>;
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
  requestId: Promise<string | undefined>;
  startedAt: number;
}

function requestIdFromHeaders(
  headers: Record<string, string> | undefined
): string | undefined {
  if (!headers) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return (
    normalized['x-request-id'] ??
    normalized['request-id'] ??
    normalized['cf-ray']
  );
}

function signalFor(
  inputSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return inputSignal ? AbortSignal.any([inputSignal, timeout]) : timeout;
}

export class ConfiguredOfficialProvider {
  constructor(
    protected readonly gateway: ModelGateway,
    readonly target: OfficialProviderTarget
  ) {}

  async complete(input: OfficialGenerationInput): Promise<ProviderResult> {
    this.assertAvailable();
    const startedAt = performance.now();
    try {
      const request = {
        ...input,
        provider: this.target.provider,
        model: this.target.model,
        baseUrl: this.target.baseUrl,
        apiKey: this.target.apiKey,
        abortSignal: signalFor(input.abortSignal, this.target.timeoutMs)
      };
      if (this.gateway.completeDetailed) {
        const result = await this.gateway.completeDetailed(request);
        const providerRequestId = requestIdFromHeaders(result.response?.headers);
        return {
          text: result.text,
          usage: result.usage,
          ...(providerRequestId ? { providerRequestId } : {}),
          latencyMs: Math.round(performance.now() - startedAt)
        };
      }
      const text = await this.gateway.complete(request);
      return {
        text,
        usage: {
          inputTokens: 0,
          outputTokens: Math.ceil(text.length / 4)
        },
        latencyMs: Math.round(performance.now() - startedAt)
      };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async stream(input: OfficialGenerationInput): Promise<ProviderStreamExecution> {
    this.assertAvailable();
    const startedAt = performance.now();
    try {
      const result = await this.gateway.stream({
        ...input,
        provider: this.target.provider,
        model: this.target.model,
        baseUrl: this.target.baseUrl,
        apiKey: this.target.apiKey,
        abortSignal: signalFor(input.abortSignal, this.target.timeoutMs)
      });
      return {
        textStream: result.textStream,
        usage: result.usage,
        requestId: result.response
          ? result.response.then((response) =>
              requestIdFromHeaders(response.headers)
            )
          : Promise.resolve(undefined),
        startedAt
      };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  private assertAvailable() {
    if (!this.target.enabled) {
      throw new AppError(
        'FREE_SERVICE_DISABLED',
        '官方免费服务当前已关闭。',
        503
      );
    }
    if (!this.target.apiKey) {
      throw new AppError(
        'CREDENTIAL_INVALID',
        '官方免费服务凭证未配置。',
        503
      );
    }
  }
}

export class GroqProvider extends ConfiguredOfficialProvider {}

export class CloudflareWorkersAIProvider extends ConfiguredOfficialProvider {}

function canFailOver(error: AppError): boolean {
  return (
    error.retryable &&
    [
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_TIMEOUT',
      'PROVIDER_UNAVAILABLE'
    ].includes(error.code)
  );
}

function unifiedUnavailable(): AppError {
  return new AppError(
    'FREE_SERVICE_UNAVAILABLE',
    '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。',
    503,
    true
  );
}

export class OfficialProviderRouter {
  constructor(private readonly providers: ConfiguredOfficialProvider[]) {}

  async complete(input: OfficialGenerationInput): Promise<OfficialCompletionResult> {
    const attempts: OfficialProviderAttempt[] = [];
    const enabledProviders = this.providers.filter(
      (provider) => provider.target.enabled
    );
    if (enabledProviders.length === 0) {
      throw new AppError(
        'FREE_SERVICE_DISABLED',
        '官方免费服务当前已关闭。',
        503
      );
    }
    for (const [index, provider] of enabledProviders.entries()) {
      const startedAt = performance.now();
      try {
        const result = await provider.complete(input);
        attempts.push({
          provider: provider.target.provider,
          model: provider.target.model,
          status: 'COMPLETED',
          latencyMs: result.latencyMs
        });
        return {
          text: result.text,
          provider: provider.target.provider,
          model: provider.target.model,
          ...(result.providerRequestId
            ? { providerRequestId: result.providerRequestId }
            : {}),
          fallbackUsed: index > 0,
          latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
          usage: result.usage,
          attempts
        };
      } catch (reason) {
        const error = normalizeProviderError(reason);
        attempts.push({
          provider: provider.target.provider,
          model: provider.target.model,
          status: 'FAILED',
          latencyMs: Math.round(performance.now() - startedAt),
          errorCode: error.code
        });
        const hasNext = index < enabledProviders.length - 1;
        if (!canFailOver(error)) throw error;
        if (!hasNext) throw unifiedUnavailable();
      }
    }
    throw unifiedUnavailable();
  }

  async stream(input: OfficialGenerationInput): Promise<OfficialStreamResult> {
    const enabledProviders = this.providers.filter(
      (provider) => provider.target.enabled
    );
    if (enabledProviders.length === 0) {
      throw new AppError(
        'FREE_SERVICE_DISABLED',
        '官方免费服务当前已关闭。',
        503
      );
    }

    let resolveCompletion!: (metadata: OfficialCompletionMetadata) => void;
    let rejectCompletion!: (reason: unknown) => void;
    const completion = new Promise<OfficialCompletionMetadata>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const textStream = (async function* () {
      const attempts: OfficialProviderAttempt[] = [];
      for (const [index, provider] of enabledProviders.entries()) {
        let emitted = false;
        const startedAt = performance.now();
        try {
          const result = await provider.stream(input);
          for await (const delta of result.textStream) {
            emitted = true;
            yield delta;
          }
          const usage = await result.usage;
          const providerRequestId = await result.requestId;
          attempts.push({
            provider: provider.target.provider,
            model: provider.target.model,
            status: 'COMPLETED',
            latencyMs: Math.round(performance.now() - result.startedAt)
          });
          resolveCompletion({
            provider: provider.target.provider,
            model: provider.target.model,
            ...(providerRequestId ? { providerRequestId } : {}),
            fallbackUsed: index > 0,
            latencyMs: attempts.reduce(
              (sum, attempt) => sum + attempt.latencyMs,
              0
            ),
            usage,
            attempts
          });
          return;
        } catch (reason) {
          const error = normalizeProviderError(reason);
          attempts.push({
            provider: provider.target.provider,
            model: provider.target.model,
            status: 'FAILED',
            latencyMs: Math.round(performance.now() - startedAt),
            errorCode: error.code
          });
          const hasNext = index < enabledProviders.length - 1;
          // Once a token was delivered, restarting on another provider would
          // duplicate user-visible text. Treat that response as incomplete.
          if (emitted || !canFailOver(error)) {
            rejectCompletion(error);
            throw error;
          }
          if (!hasNext) {
            const unavailable = unifiedUnavailable();
            rejectCompletion(unavailable);
            throw unavailable;
          }
        }
      }
      const unavailable = unifiedUnavailable();
      rejectCompletion(unavailable);
      throw unavailable;
    })();

    return { textStream, completion };
  }
}

function providerFor(
  gateway: ModelGateway,
  target: OfficialProviderTarget
): ConfiguredOfficialProvider {
  if (target.provider === 'groq') return new GroqProvider(gateway, target);
  if (target.provider === 'cloudflare') {
    return new CloudflareWorkersAIProvider(gateway, target);
  }
  return new ConfiguredOfficialProvider(gateway, target);
}

export function createOfficialProviderRouter(
  gateway: ModelGateway,
  config: PlatformProviderConfig
): OfficialProviderRouter {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const targets: OfficialProviderTarget[] = [
    {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      enabled: config.enabled ?? true,
      timeoutMs
    }
  ];
  if (config.fallback) {
    targets.push({
      ...config.fallback,
      timeoutMs
    });
  }
  return new OfficialProviderRouter(
    targets.map((target) => providerFor(gateway, target))
  );
}
