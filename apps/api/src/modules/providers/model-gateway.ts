import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, type ModelMessage } from 'ai';
import { getProviderRuntimePreset } from '@litetavern/contracts';
import { AppError } from '../../lib/errors.js';

export interface ProviderGatewayInput {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ProviderValidationResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
}

export interface ProviderStreamInput extends ProviderGatewayInput {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface ProviderStreamResult {
  textStream: AsyncIterable<string>;
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
  response?: Promise<{ headers?: Record<string, string> }>;
}

export interface ProviderCompletionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  response?: { headers?: Record<string, string> };
}

export interface ModelGateway {
  validate(input: ProviderGatewayInput): Promise<ProviderValidationResult>;
  listModels(input: Omit<ProviderGatewayInput, 'model'>): Promise<string[]>;
  stream(input: ProviderStreamInput): Promise<ProviderStreamResult>;
  complete(input: ProviderStreamInput): Promise<string>;
  completeDetailed?(input: ProviderStreamInput): Promise<ProviderCompletionResult>;
}

function providerProtocol(input: ProviderGatewayInput) {
  if (input.provider === 'cloudflare') return 'openai-compatible' as const;
  return getProviderRuntimePreset(input.provider).protocol;
}

function createModel(input: ProviderGatewayInput) {
  const protocol = providerProtocol(input);
  if (protocol === 'anthropic') {
    return createAnthropic({
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseURL: input.baseUrl } : {})
    })(input.model);
  }
  if (protocol === 'google') {
    return createGoogleGenerativeAI({
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseURL: input.baseUrl } : {})
    })(input.model);
  }
  const compatible = createOpenAICompatible({
    name: input.provider,
    apiKey: input.apiKey || 'local-no-key',
    baseURL: input.baseUrl
  });
  return compatible(input.model);
}

async function* demoText(message: string) {
  const response = message.includes('比赛')
    ? '我记得你一直在准备那场比赛。现在终于结束了，辛苦了。愿意和我说说最难忘的瞬间吗？'
    : `我听见了：“${message.slice(0, 80)}”。我们可以从这里慢慢聊下去。`;
  for (const part of response.match(/.{1,8}/gu) ?? []) yield part;
}

function headersOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const headers = value as Record<string, string>;
  return headers;
}

export function createModelGateway(): ModelGateway {
  async function completeDetailed(
    input: ProviderStreamInput
  ): Promise<ProviderCompletionResult> {
    if (input.provider === 'demo') {
      const text = JSON.stringify(['嗯，好啊。', '让我想想…', '这个嘛，改天再聊？']);
      return {
        text,
        usage: { inputTokens: 0, outputTokens: Math.ceil(text.length / 4) }
      };
    }
    try {
      const result = await generateText({
        model: createModel(input),
        system: input.system,
        messages: input.messages,
        maxOutputTokens: input.maxOutputTokens ?? 256,
        temperature: input.temperature ?? 0.9,
        maxRetries: 0,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      const responseHeaders = headersOf(result.response.headers);
      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0
        },
        ...(responseHeaders ? { response: { headers: responseHeaders } } : {})
      };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  return {
    async validate(input) {
      const startedAt = performance.now();
      if (input.provider === 'demo') {
        return { ok: true, latencyMs: 0, models: ['litetavern-demo'] };
      }
      try {
        const models = await this.listModels({
          provider: input.provider,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey
        });
        const manual =
          input.provider === 'cloudflare' ||
          getProviderRuntimePreset(input.provider).modelDiscovery === 'manual';
        if (manual || models.length === 0) {
          await generateText({
            model: createModel(input),
            prompt: 'Reply with OK.',
            maxOutputTokens: 2,
            maxRetries: 0
          });
        }
        return {
          ok: true,
          latencyMs: Math.round(performance.now() - startedAt),
          models: models.length > 0 ? models : [input.model]
        };
      } catch (error) {
        throw normalizeProviderError(error);
      }
    },

    async listModels(input) {
      if (input.provider === 'demo') return ['litetavern-demo'];
      if (input.provider === 'cloudflare') return [];
      const preset = getProviderRuntimePreset(input.provider);
      if (preset.modelDiscovery === 'manual') return [...preset.placeholderModels];
      try {
        const baseUrl = input.baseUrl.replace(/\/$/, '');
        const headers = new Headers({ Accept: 'application/json' });
        if (input.apiKey) {
          if (preset.protocol === 'anthropic') headers.set('x-api-key', input.apiKey);
          else if (preset.protocol === 'google') headers.set('x-goog-api-key', input.apiKey);
          else headers.set('Authorization', `Bearer ${input.apiKey}`);
        }
        const path = preset.protocol === 'google' ? '/v1beta/models' : '/models';
        const response = await fetch(`${baseUrl}${path}`, {
          headers,
          signal: AbortSignal.timeout(12_000)
        });
        if (!response.ok) {
          const error = new Error(`Provider returned ${response.status}`) as Error & {
            statusCode?: number;
          };
          error.statusCode = response.status;
          throw error;
        }
        const payload = (await response.json()) as {
          data?: Array<{ id?: string }>;
          models?: Array<{ name?: string }>;
        };
        return (
          payload.data?.map((model) => model.id).filter(Boolean) ??
          payload.models?.map((model) => model.name?.replace(/^models\//, '')).filter(Boolean) ??
          []
        ) as string[];
      } catch (error) {
        throw normalizeProviderError(error);
      }
    },

    async stream(input) {
      if (input.provider === 'demo') {
        const last = [...input.messages].reverse().find((message) => message.role === 'user');
        const text = typeof last?.content === 'string' ? last.content : '';
        return {
          textStream: demoText(text),
          usage: Promise.resolve({
            inputTokens: Math.ceil(text.length / 4),
            outputTokens: 32
          })
        };
      }
      try {
        const result = streamText({
          model: createModel(input),
          system: input.system,
          messages: input.messages,
          maxOutputTokens: input.maxOutputTokens ?? 2048,
          temperature: input.temperature ?? 0.8,
          maxRetries: 0,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        });
        return {
          textStream: result.textStream,
          usage: Promise.resolve(result.usage).then((usage) => ({
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0
          })),
          response: Promise.resolve(result.response).then((response) => {
            const headers = headersOf(response.headers);
            return headers ? { headers } : {};
          })
        };
      } catch (error) {
        throw normalizeProviderError(error);
      }
    },

    async complete(input) {
      return (await completeDetailed(input)).text;
    },

    completeDetailed
  };
}

function numericStatus(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (!error || typeof error !== 'object' || seen.has(error)) return undefined;
  seen.add(error);
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
  };
  for (const value of [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status
  ]) {
    if (typeof value === 'number') return value;
  }
  return numericStatus(candidate.cause, seen);
}

export function normalizeProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const status = numericStatus(error);
  if (
    status === 401 ||
    status === 403 ||
    message.includes('api key') ||
    message.includes('unauthorized')
  ) {
    return new AppError('CREDENTIAL_INVALID', 'Provider 服务端凭证配置无效。', 503);
  }
  if (
    message.includes('safety') ||
    message.includes('moderation') ||
    message.includes('content policy')
  ) {
    return new AppError(
      'PROVIDER_SAFETY_REJECTED',
      '请求被内容安全策略拒绝。',
      400
    );
  }
  if (status === 429 || message.includes('429') || message.includes('rate limit')) {
    return new AppError(
      'PROVIDER_RATE_LIMITED',
      '模型服务当前请求过多，请稍后重试。',
      429,
      true
    );
  }
  if (
    message.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('aborterror')
  ) {
    return new AppError('PROVIDER_TIMEOUT', '模型服务响应超时。', 504, true);
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new AppError(
      'PROVIDER_REQUEST_INVALID',
      '模型服务拒绝了请求参数。',
      400
    );
  }
  if (
    (status !== undefined && status >= 500) ||
    message.includes('fetch failed') ||
    message.includes('econn') ||
    message.includes('network') ||
    message.includes('socket')
  ) {
    return new AppError(
      'PROVIDER_UNAVAILABLE',
      '暂时无法连接模型服务。',
      502,
      true
    );
  }
  return new AppError('PROVIDER_UNAVAILABLE', '暂时无法连接模型服务。', 502, true);
}
