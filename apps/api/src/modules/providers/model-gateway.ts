import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, type ModelMessage } from 'ai';
import { getProviderRuntimePreset } from '@pomchat/contracts';
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
}

export interface ModelGateway {
  validate(input: ProviderGatewayInput): Promise<ProviderValidationResult>;
  listModels(input: Omit<ProviderGatewayInput, 'model'>): Promise<string[]>;
  stream(input: ProviderStreamInput): Promise<ProviderStreamResult>;
  complete(input: ProviderStreamInput): Promise<string>;
}

function createModel(input: ProviderGatewayInput) {
  const preset = getProviderRuntimePreset(input.provider);
  if (preset.protocol === 'anthropic') {
    return createAnthropic({
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseURL: input.baseUrl } : {})
    })(input.model);
  }
  if (preset.protocol === 'google') {
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

export function createModelGateway(): ModelGateway {
  return {
    async validate(input) {
      const startedAt = performance.now();
      if (input.provider === 'demo') {
        return { ok: true, latencyMs: 0, models: ['pomchat-demo'] };
      }
      try {
        const preset = getProviderRuntimePreset(input.provider);
        const models = await this.listModels({
          provider: input.provider,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey
        });
        if (preset.modelDiscovery === 'manual' || models.length === 0) {
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
      if (input.provider === 'demo') return ['pomchat-demo'];
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
        if (!response.ok) throw new Error(`Provider returned ${response.status}`);
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
          usage: Promise.resolve({ inputTokens: Math.ceil(text.length / 4), outputTokens: 32 })
        };
      }
      try {
        const result = streamText({
          model: createModel(input),
          system: input.system,
          messages: input.messages,
          maxOutputTokens: input.maxOutputTokens ?? 2048,
          temperature: input.temperature ?? 0.8,
          maxRetries: 1,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        });
        return {
          textStream: result.textStream,
          usage: Promise.resolve(result.usage).then((usage) => ({
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0
          }))
        };
      } catch (error) {
        throw normalizeProviderError(error);
      }
    },
    async complete(input) {
      if (input.provider === 'demo') {
        return JSON.stringify(['嗯，好啊。', '让我想想…', '这个嘛，改天再聊？']);
      }
      try {
        const { text } = await generateText({
          model: createModel(input),
          system: input.system,
          messages: input.messages,
          maxOutputTokens: input.maxOutputTokens ?? 256,
          temperature: input.temperature ?? 0.9,
          maxRetries: 1,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
        });
        return text;
      } catch (error) {
        throw normalizeProviderError(error);
      }
    }
  };
}

function normalizeProviderError(error: unknown): AppError {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('401') || message.includes('403') || message.includes('api key')) {
    return new AppError('CREDENTIAL_INVALID', '凭证验证失败，请检查 API Key。', 400);
  }
  if (message.includes('429') || message.includes('rate')) {
    return new AppError('PROVIDER_RATE_LIMITED', '模型服务当前请求过多，请稍后重试。', 429, true);
  }
  if (message.includes('timeout') || message.includes('aborted')) {
    return new AppError('PROVIDER_TIMEOUT', '模型服务响应超时。', 504, true);
  }
  return new AppError('PROVIDER_UNAVAILABLE', '暂时无法连接模型服务。', 502, true);
}
