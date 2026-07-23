import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp } from './app.js';
import type {
  ModelGateway,
  ProviderStreamInput
} from './modules/providers/model-gateway.js';
import { insertTestCharacter } from './test-fixtures.js';

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const openDatabases: PomChatDatabase[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

function streamOf(text: string): AsyncIterable<string> {
  return (async function* () {
    yield text.slice(0, 4);
    yield text.slice(4);
  })();
}

async function setup() {
  const seen: ProviderStreamInput[] = [];
  const database = await createDatabase({ dataDir: 'memory://' });
  const gateway: ModelGateway = {
    async validate(input) {
      return { ok: true, latencyMs: 1, models: [input.model] };
    },
    async listModels() {
      return [];
    },
    async stream(input) {
      seen.push(input);
      return {
        textStream: streamOf('收到，我们继续聊。'),
        usage: Promise.resolve({ inputTokens: 16, outputTokens: 8 })
      };
    },
    async complete(input) {
      seen.push(input);
      return '["好啊，走吧","让我想想","改天再说"]';
    }
  };
  const app = await buildApp({
    database,
    gateway,
    platform: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'platform-only-secret',
      dailyTokenQuota: 10_000
    }
  });
  openApps.push(app);
  openDatabases.push(database);

  const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
  const cookie = String(identity.headers['set-cookie']).split(';')[0];
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
    seen,
    cookie,
    conversationId: conversation.json().conversation_id as string
  };
}

describe('generation credential and billing isolation', () => {
  it('uses only the server credential and PLATFORM ledger for official quota', async () => {
    const { app, database, seen, cookie, conversationId } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/generations`,
      headers: { cookie, 'idempotency-key': 'platform-turn-1' },
      payload: {
        usage_mode: 'PLATFORM',
        input: { type: 'text', text: '今天比赛结束了。' }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: delta');
    expect(response.body).toContain('event: done');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKey: 'platform-only-secret'
    });

    const ledger = await database.query<{ usage_mode: string; status: string }>(
      `SELECT usage_mode, status FROM model_usage_ledger`
    );
    expect(ledger.rows).toEqual([{ usage_mode: 'PLATFORM', status: 'FINALIZED' }]);
  });

  it('uses the matching browser credential and never falls back to the platform secret', async () => {
    const { app, database, seen, cookie, conversationId } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/model-configurations',
      headers: { cookie },
      payload: {
        provider: 'moonshot',
        display_name: 'Kimi',
        model_name: 'kimi-k2.5',
        base_url: 'https://api.moonshot.cn/v1',
        credential_id: 'browser-kimi-1'
      }
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/generations`,
      headers: { cookie, 'idempotency-key': 'byok-turn-1' },
      payload: {
        usage_mode: 'BYOK',
        model_configuration_id: created.json().model_configuration_id,
        credential: {
          credential_id: 'browser-kimi-1',
          api_key: 'browser-only-secret'
        },
        input: { type: 'text', text: '你还记得吗？' }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      apiKey: 'browser-only-secret'
    });
    expect(JSON.stringify(seen[0])).not.toContain('platform-only-secret');
    const ledger = await database.query<{ usage_mode: string }>(
      `SELECT usage_mode FROM model_usage_ledger`
    );
    expect(ledger.rows).toEqual([{ usage_mode: 'BYOK' }]);
  });

  it('rejects a missing BYOK credential before calling any provider', async () => {
    const { app, seen, cookie, conversationId } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/generations`,
      headers: { cookie, 'idempotency-key': 'missing-byok-key' },
      payload: {
        usage_mode: 'BYOK',
        model_configuration_id: 'b739a6ca-89d4-4fd7-bc98-1ad0e8d05c96',
        input: { type: 'text', text: '不能偷偷使用官方额度。' }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('executes an idempotency key only once', async () => {
    const { app, database, seen, cookie, conversationId } = await setup();
    const request = {
      method: 'POST' as const,
      url: `/v1/conversations/${conversationId}/generations`,
      headers: { cookie, 'idempotency-key': 'same-turn' },
      payload: {
        usage_mode: 'PLATFORM',
        input: { type: 'text', text: '只发送一次。' }
      }
    };

    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    const requests = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM agent_generation_request`
    );
    expect(requests.rows[0]?.count).toBe(1);
  });

  it('returns model-generated reply suggestions using the platform credential', async () => {
    const { app, seen, cookie, conversationId } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/reply-suggestions`,
      headers: { cookie },
      payload: { usage_mode: 'PLATFORM' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().suggestions).toEqual(['好啊，走吧', '让我想想', '改天再说']);
    // The suggestion call goes through the gateway with the server-side credential only.
    expect(seen.at(-1)).toMatchObject({ apiKey: 'platform-only-secret' });
  });
});
