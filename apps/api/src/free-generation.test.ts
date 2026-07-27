import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp } from './app.js';
import { AppError } from './lib/errors.js';
import type { ModelGateway, ProviderStreamInput } from './modules/providers/model-gateway.js';
import { insertTestCharacter } from './test-fixtures.js';

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const openDatabases: PomChatDatabase[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

function officialConfig() {
  return {
    provider: 'groq',
    model: 'groq-configured-model',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'groq-server-secret',
    dailyTokenQuota: 10_000,
    enabled: true,
    initialQuota: 30,
    timeoutMs: 5_000,
    fallback: {
      provider: 'cloudflare',
      model: 'cloudflare-configured-model',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1',
      apiKey: 'cloudflare-server-secret',
      enabled: true
    }
  };
}

async function setup(complete: ModelGateway['complete']) {
  const seen: ProviderStreamInput[] = [];
  const database = await createDatabase({ dataDir: 'memory://' });
  const gateway: ModelGateway = {
    async validate(input) {
      return { ok: true, latencyMs: 1, models: [input.model] };
    },
    async listModels() {
      return [];
    },
    async stream() {
      throw new Error('unused');
    },
    async complete(input) {
      seen.push(input);
      return complete(input);
    }
  };
  const app = await buildApp({ database, gateway, platform: officialConfig() });
  openApps.push(app);
  openDatabases.push(database);
  const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
  const cookie = String(identity.headers['set-cookie']).split(';')[0] ?? '';
  const userId = identity.json().user.user_id as string;
  const characterId = await insertTestCharacter(database);
  const conversation = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: { cookie },
    payload: { character_id: characterId }
  });
  return {
    app,
    database,
    cookie,
    userId,
    seen,
    conversationId: conversation.json().conversation_id as string
  };
}

async function generate(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  conversationId: string,
  idempotencyKey: string
) {
  return app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/turns`,
    headers: {
      cookie,
      'idempotency-key': idempotencyKey,
      'x-pomchat-session-id': 'session-free-quota'
    },
    payload: {
      usage_mode: 'PLATFORM',
      input: { type: 'text', text: '你好' }
    }
  });
}

describe('official free generation integration', () => {
  it('deducts one reply after a successful Groq completion', async () => {
    const { app, database, cookie, userId, seen, conversationId } = await setup(
      async () => '{"messages":["你好。"]}'
    );
    const response = await generate(app, cookie, conversationId, 'success-once');

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ free_quota_remaining: 29 });
    expect(seen.map((request) => request.provider)).toEqual(['groq']);
    const user = await database.query<{ remaining: number }>(
      `SELECT free_quota_remaining AS remaining FROM app_user WHERE user_id = $1`,
      [userId]
    );
    expect(user.rows[0]?.remaining).toBe(29);
  });

  it('falls back from retryable Groq failure and still deducts only once', async () => {
    const complete = vi
      .fn<ModelGateway['complete']>()
      .mockRejectedValueOnce(
        new AppError('PROVIDER_RATE_LIMITED', 'Groq raw rate error', 429, true)
      )
      .mockResolvedValueOnce('{"messages":["备用成功。"]}');
    const { app, database, cookie, conversationId } = await setup(complete);
    const response = await generate(app, cookie, conversationId, 'fallback-success');

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ free_quota_remaining: 29 });
    expect(complete).toHaveBeenCalledTimes(2);
    const generation = await database.query<{
      provider: string;
      fallback_used: boolean;
      status: string;
    }>(
      `SELECT provider, fallback_used, status FROM agent_generation_request`
    );
    expect(generation.rows).toEqual([
      { provider: 'cloudflare', fallback_used: true, status: 'COMPLETED' }
    ]);
  });

  it('does not deduct when both providers fail', async () => {
    const { app, database, cookie, userId, conversationId } = await setup(async () => {
      throw new AppError('PROVIDER_UNAVAILABLE', 'raw upstream error', 502, true);
    });
    const response = await generate(app, cookie, conversationId, 'both-fail');

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: 'FREE_SERVICE_UNAVAILABLE',
      message: '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。'
    });
    expect(response.body).not.toContain('raw upstream error');
    const user = await database.query<{ remaining: number; reserved: number }>(
      `SELECT free_quota_remaining AS remaining, free_quota_reserved AS reserved
       FROM app_user WHERE user_id = $1`,
      [userId]
    );
    expect(user.rows[0]).toEqual({ remaining: 30, reserved: 0 });
  });

  it('does not call a provider when quota is zero', async () => {
    const complete = vi.fn(async () => '{"messages":["must not run"]}');
    const { app, database, cookie, userId, conversationId } = await setup(complete);
    await database.query(
      `UPDATE app_user SET free_quota_remaining = 0 WHERE user_id = $1`,
      [userId]
    );

    const response = await generate(app, cookie, conversationId, 'empty-quota');

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('FREE_QUOTA_EXHAUSTED');
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps idempotent retries and concurrent requests from double-spending', async () => {
    const complete = vi.fn(async () => '{"messages":["ok"]}');
    const { app, database, cookie, userId, conversationId } = await setup(complete);
    await database.query(
      `UPDATE app_user
       SET free_quota_total = 1, free_quota_remaining = 1
       WHERE user_id = $1`,
      [userId]
    );

    const sameFirst = await generate(app, cookie, conversationId, 'same-request');
    const sameReplay = await generate(app, cookie, conversationId, 'same-request');
    expect(sameFirst.statusCode).toBe(201);
    expect(sameReplay.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);

    await database.query(
      `UPDATE app_user
       SET free_quota_total = 1, free_quota_remaining = 1, free_quota_reserved = 0
       WHERE user_id = $1`,
      [userId]
    );
    const [parallelA, parallelB] = await Promise.all([
      generate(app, cookie, conversationId, 'parallel-a'),
      generate(app, cookie, conversationId, 'parallel-b')
    ]);
    expect([parallelA.statusCode, parallelB.statusCode].sort()).toEqual([201, 429]);
    expect(complete).toHaveBeenCalledTimes(2);
    const balance = await database.query<{ remaining: number }>(
      `SELECT free_quota_remaining AS remaining FROM app_user WHERE user_id = $1`,
      [userId]
    );
    expect(balance.rows[0]?.remaining).toBe(0);
  });

  it('smoke-tests five continuous turns with one character and preserves context', async () => {
    let turn = 0;
    const { app, cookie, seen, conversationId } = await setup(async () => {
      turn += 1;
      return JSON.stringify({ messages: [`第 ${turn} 轮回复`] });
    });

    let remaining = 30;
    for (let index = 1; index <= 5; index += 1) {
      const response = await generate(
        app,
        cookie,
        conversationId,
        `smoke-turn-${index}`
      );
      expect(response.statusCode).toBe(201);
      remaining = response.json().free_quota_remaining as number;
      const text = (response.json().messages as string[])[0]!;
      const saved = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/turns/${response.json().turn_id}/bubbles`,
        headers: { cookie },
        payload: {
          message_id: randomUUID(),
          text,
          bubble_no: 1
        }
      });
      expect(saved.statusCode).toBe(201);
    }

    expect(remaining).toBe(25);
    expect(seen).toHaveLength(5);
    expect(seen.at(-1)?.messages.filter((message) => message.role === 'user')).toHaveLength(5);
    expect(
      seen.at(-1)?.messages.filter((message) => message.role === 'assistant')
    ).toHaveLength(5);
  });
});
