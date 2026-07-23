import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp, type BuildAppOptions } from './app.js';
import type { ModelGateway } from './modules/providers/model-gateway.js';
import { insertTestCharacter } from './test-fixtures.js';

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const openDatabases: PomChatDatabase[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

async function setup(options: Partial<BuildAppOptions> = {}) {
  const database = options.database ?? (await createDatabase({ dataDir: 'memory://' }));
  const app = await buildApp({ ...options, database });
  openApps.push(app);
  openDatabases.push(database);
  return { app, database };
}

async function anonymousCookie(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  expect(setCookie).toBeTypeOf('string');
  return String(setCookie).split(';')[0];
}

describe('PomChat API', () => {
  it('rejects state-changing browser requests from an untrusted origin', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/identities/anonymous',
      headers: { origin: 'https://attacker.example' }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CROSS_ORIGIN_REQUEST_REJECTED');
  });

  it('adds baseline security headers to API responses', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('creates an anonymous identity without inventing hard-coded characters', async () => {
    const { app } = await setup();
    const cookie = await anonymousCookie(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/characters',
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().characters).toEqual([]);
  });

  it('does not allow another anonymous identity to read a conversation', async () => {
    const { app, database } = await setup();
    const ownerCookie = await anonymousCookie(app);
    const strangerCookie = await anonymousCookie(app);
    const characterId = await insertTestCharacter(database);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie: ownerCookie },
      payload: { character_id: characterId }
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${created.json().conversation_id}`,
      headers: { cookie: strangerCookie }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('persists provider configuration without accepting or storing a key', async () => {
    const { app, database } = await setup();
    const cookie = await anonymousCookie(app);
    const secret = 'sk-this-must-never-be-stored';

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/model-configurations',
      headers: { cookie },
      payload: {
        provider: 'deepseek',
        display_name: 'DeepSeek',
        model_name: 'deepseek-v4-flash',
        base_url: 'https://api.deepseek.com',
        credential_id: 'browser-credential-1',
        api_key: secret
      }
    });
    expect(rejected.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/model-configurations',
      headers: { cookie },
      payload: {
        provider: 'deepseek',
        display_name: 'DeepSeek',
        model_name: 'deepseek-v4-flash',
        base_url: 'https://api.deepseek.com',
        credential_id: 'browser-credential-1'
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty('api_key');

    const dump = await database.query<{ value: string }>(
      `SELECT COALESCE(string_agg(row_to_json(c)::text, ''), '') AS value
       FROM model_configuration c`
    );
    expect(dump.rows[0]?.value).not.toContain(secret);
  });

  it('uses a BYOK key only during provider validation', async () => {
    const seenKeys: string[] = [];
    const gateway: ModelGateway = {
      async validate(input) {
        seenKeys.push(input.apiKey);
        return { ok: true, latencyMs: 12, models: [input.model] };
      },
      async listModels() {
        return [];
      },
      async stream() {
        throw new Error('not used');
      },
      async complete() {
        throw new Error('not used');
      }
    };
    const { app, database } = await setup({ gateway });
    const cookie = await anonymousCookie(app);
    const secret = 'sk-ephemeral-validation-key';

    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-connections/validate',
      headers: { cookie },
      payload: {
        provider: 'deepseek',
        base_url: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        credential: { credential_id: 'local-1', api_key: secret }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(seenKeys).toEqual([secret]);
    expect(response.body).not.toContain(secret);
    const stored = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM model_configuration`
    );
    expect(stored.rows[0]?.count).toBe(0);
  });
});
