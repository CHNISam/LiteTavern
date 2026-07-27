import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../lib/errors.js';
import type {
  ModelGateway,
  ProviderStreamInput
} from './model-gateway.js';
import {
  CloudflareWorkersAIProvider,
  GroqProvider,
  OfficialProviderRouter,
  type OfficialProviderTarget
} from './official-providers.js';

const input: Omit<ProviderStreamInput, 'provider' | 'model' | 'baseUrl' | 'apiKey'> = {
  system: 'Stay in character.',
  messages: [{ role: 'user', content: '你好' }]
};

function target(
  provider: 'groq' | 'cloudflare',
  overrides: Partial<OfficialProviderTarget> = {}
): OfficialProviderTarget {
  return {
    provider,
    model: `${provider}-configured-model`,
    baseUrl:
      provider === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1',
    apiKey: `${provider}-server-secret`,
    enabled: true,
    timeoutMs: 5_000,
    ...overrides
  };
}

function gateway(
  complete: ModelGateway['complete'],
  stream: ModelGateway['stream'] = async () => {
    throw new Error('unused');
  }
): ModelGateway {
  return {
    async validate(request) {
      return { ok: true, latencyMs: 1, models: [request.model] };
    },
    async listModels() {
      return [];
    },
    stream,
    complete
  };
}

function router(modelGateway: ModelGateway) {
  return new OfficialProviderRouter([
    new GroqProvider(modelGateway, target('groq')),
    new CloudflareWorkersAIProvider(modelGateway, target('cloudflare'))
  ]);
}

describe('official free provider routing', () => {
  it('uses Groq only when the primary succeeds', async () => {
    const complete = vi.fn(async () => 'Groq reply');
    const result = await router(gateway(complete)).complete(input);

    expect(result.text).toBe('Groq reply');
    expect(result.provider).toBe('groq');
    expect(result.fallbackUsed).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['429', new AppError('PROVIDER_RATE_LIMITED', 'rate limited', 429, true)],
    ['5xx', new AppError('PROVIDER_UNAVAILABLE', 'upstream unavailable', 502, true)],
    ['timeout', new AppError('PROVIDER_TIMEOUT', 'upstream timeout', 504, true)]
  ])('falls back to Cloudflare for a retryable Groq %s failure', async (_case, failure) => {
    const complete = vi
      .fn<ModelGateway['complete']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('Cloudflare reply');

    const result = await router(gateway(complete)).complete(input);

    expect(result.text).toBe('Cloudflare reply');
    expect(result.provider).toBe('cloudflare');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.map((attempt) => attempt.provider)).toEqual(['groq', 'cloudflare']);
  });

  it('does not fall back for invalid parameters or credentials', async () => {
    const complete = vi
      .fn<ModelGateway['complete']>()
      .mockRejectedValue(
        new AppError('PROVIDER_REQUEST_INVALID', 'invalid upstream request', 400, false)
      );

    await expect(router(gateway(complete)).complete(input)).rejects.toMatchObject({
      code: 'PROVIDER_REQUEST_INVALID'
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('returns one sanitized business error when both providers fail', async () => {
    const complete = vi
      .fn<ModelGateway['complete']>()
      .mockRejectedValue(
        new AppError('PROVIDER_UNAVAILABLE', 'raw provider detail', 502, true)
      );

    await expect(router(gateway(complete)).complete(input)).rejects.toMatchObject({
      code: 'FREE_SERVICE_UNAVAILABLE',
      message: '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。'
    });
    try {
      await router(gateway(complete)).complete(input);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('groq-server-secret');
      expect(JSON.stringify(error)).not.toContain('cloudflare-server-secret');
      expect(JSON.stringify(error)).not.toContain('raw provider detail');
    }
  });

  it('falls back before the first streamed token and reports the actual provider', async () => {
    const stream = vi
      .fn<ModelGateway['stream']>()
      .mockResolvedValueOnce({
        textStream: (async function* () {
          yield* [];
          throw new AppError('PROVIDER_TIMEOUT', 'timeout', 504, true);
        })(),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 })
      })
      .mockResolvedValueOnce({
        textStream: (async function* () {
          yield '备用';
          yield '回复';
        })(),
        usage: Promise.resolve({ inputTokens: 8, outputTokens: 4 })
      });
    const result = await router(gateway(async () => 'unused', stream)).stream(input);
    let text = '';
    for await (const delta of result.textStream) text += delta;
    const completion = await result.completion;

    expect(text).toBe('备用回复');
    expect(completion).toMatchObject({
      provider: 'cloudflare',
      fallbackUsed: true,
      usage: { inputTokens: 8, outputTokens: 4 }
    });
  });
});
