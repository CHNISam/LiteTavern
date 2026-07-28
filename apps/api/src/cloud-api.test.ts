import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp } from './app.js';
import { loadCloudConfig, type CloudConfig } from './modules/cloud/config.js';
import type { ModelGateway } from './modules/providers/model-gateway.js';
import { insertTestCharacter } from './test-fixtures.js';

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
const openDatabases: PomChatDatabase[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

const ADMIN_TOKEN = 'test-admin-token';

function cloudConfig(overrides: Partial<CloudConfig> = {}): CloudConfig {
  const base = loadCloudConfig({});
  return {
    ...base,
    adminToken: ADMIN_TOKEN,
    support: {
      enabled: true,
      url: 'https://example.test/support',
      headline: '支持 LiteTavern',
      body: '你的贡献将用于 LiteTavern Cloud 的模型额度、服务器和持续开发。',
      thanksListEnabled: true
    },
    ...overrides
  };
}

function platformConfig() {
  return {
    provider: 'groq',
    model: 'groq-configured-model',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'groq-server-secret',
    dailyTokenQuota: 10_000,
    enabled: true,
    initialQuota: 30,
    timeoutMs: 5_000
  };
}

function stubGateway(reply = '{"messages":["好呀"]}'): ModelGateway {
  return {
    async validate(input) {
      return { ok: true, latencyMs: 1, models: [input.model] };
    },
    async listModels() {
      return [];
    },
    async stream() {
      throw new Error('unused');
    },
    async complete() {
      return reply;
    }
  };
}

async function setup(overrides: Partial<CloudConfig> = {}) {
  const database = await createDatabase({ dataDir: 'memory://' });
  const app = await buildApp({
    database,
    gateway: stubGateway(),
    platform: platformConfig(),
    cloud: cloudConfig(overrides)
  });
  openApps.push(app);
  openDatabases.push(database);
  const identity = await app.inject({
    method: 'POST',
    url: '/v1/identities/anonymous'
  });
  const cookie = String(identity.headers['set-cookie']).split(';')[0] ?? '';
  return {
    app,
    database,
    cookie,
    userId: identity.json().user.user_id as string
  };
}

async function register(
  app: Awaited<ReturnType<typeof buildApp>>,
  database: PomChatDatabase,
  cookie: string,
  email: string
) {
  await app.inject({
    method: 'POST',
    url: '/v1/auth/email-code/send',
    headers: { cookie },
    payload: { email }
  });
  // The code itself is never readable; tests consume the stored hash's plaintext by
  // brute-forcing the 6-digit space against the same hash the server stored.
  const stored = await database.query<{ code_hash: string }>(
    `SELECT code_hash FROM auth_email_verification_code
     WHERE email_normalized = $1 AND consumed_at IS NULL`,
    [email]
  );
  const { createHash } = await import('node:crypto');
  let code = '';
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const guess = String(candidate).padStart(6, '0');
    const hash = createHash('sha256').update(`${email}:${guess}`).digest('hex');
    if (hash === stored.rows[0]?.code_hash) {
      code = guess;
      break;
    }
  }
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/auth/email-code/verify',
    headers: { cookie },
    payload: { email, code }
  });
  return {
    outcome: verify.json().outcome as string,
    cookie: String(verify.headers['set-cookie']).split(';')[0] ?? cookie,
    userId: verify.json().user.user_id as string
  };
}

describe('cloud status', () => {
  it('reports an anonymous visitor as a Trial user with a full allowance', async () => {
    const { app, cookie } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cloud/status',
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().cloud).toMatchObject({
      stage: 'ALPHA',
      identity_type: 'ANONYMOUS',
      registered: false,
      membership_status: 'ANONYMOUS_TRIAL',
      alpha_active: false,
      founding_supporter: false,
      quota: { source: 'TRIAL', total: 30, available: 30, remaining_ratio: 1 }
    });
    expect(response.json().cloud.next_actions).toContain('REGISTER');
  });

  it('grants the Trial exactly once, no matter how often the client bootstraps', async () => {
    const { app, database, cookie, userId } = await setup();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/identities/anonymous',
        headers: { cookie }
      });
    }

    const users = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM app_user WHERE status = 'ACTIVE'`
    );
    const grants = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM free_quota_ledger
       WHERE user_id = $1 AND action_type = 'GRANT'`,
      [userId]
    );
    expect(users.rows[0]?.count).toBe(1);
    expect(grants.rows[0]?.count).toBe(1);
  });

  it('keeps user_id and data on registration and only joins the waitlist', async () => {
    const { app, database, cookie, userId } = await setup();
    const characterId = await insertTestCharacter(database);
    await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie },
      payload: { character_id: characterId }
    });

    const registration = await register(
      app,
      database,
      cookie,
      'alpha-user@example.com'
    );

    expect(registration.outcome).toBe('REGISTERED');
    expect(registration.userId).toBe(userId);
    const conversations = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM chat_conversation WHERE user_id = $1`,
      [userId]
    );
    expect(conversations.rows[0]?.count).toBe(1);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/cloud/status',
      headers: { cookie: registration.cookie }
    });
    expect(status.json().cloud).toMatchObject({
      registered: true,
      membership_status: 'REGISTERED_WAITLIST',
      alpha_active: false
    });
    // Waitlisted is not entitled: no Alpha cycle exists yet.
    const cycles = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM cloud_quota_cycle WHERE user_id = $1`,
      [userId]
    );
    expect(cycles.rows[0]?.count).toBe(0);
  });

  it('records the program funnel events', async () => {
    const { app, database, cookie } = await setup();
    await register(app, database, cookie, 'funnel@example.com');

    const events = await database.query<{ event_name: string }>(
      `SELECT DISTINCT event_name FROM analytics_event ORDER BY event_name`
    );
    const names = events.rows.map((row) => row.event_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'anonymous_created',
        'cloud_trial_granted',
        'registration_started',
        'verification_code_sent',
        'registration_completed',
        'alpha_waitlist_joined'
      ])
    );
  });
});

describe('cloud admin', () => {
  const adminHeaders = { 'x-litetavern-admin-token': ADMIN_TOKEN };

  it('hides the admin surface entirely when no token is configured', async () => {
    const { app } = await setup({ adminToken: '' });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cloud/admin/batches'
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a wrong admin token', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cloud/admin/batches',
      headers: { 'x-litetavern-admin-token': 'wrong-token-value' }
    });

    expect(response.statusCode).toBe(401);
  });

  it('creates a batch, releases a waitlisted user and activates their quota', async () => {
    const { app, database, cookie } = await setup();
    const registration = await register(
      app,
      database,
      cookie,
      'release@example.com'
    );

    const batch = await app.inject({
      method: 'POST',
      url: '/v1/cloud/admin/batches',
      headers: adminHeaders,
      payload: {
        name: 'alpha-wave-1',
        capacity: 10,
        quota_policy: { cycle_units: 120, cycle_days: 14 }
      }
    });
    expect(batch.statusCode).toBe(201);
    const batchId = batch.json().batch.batch_id as string;

    const waitlist = await app.inject({
      method: 'GET',
      url: '/v1/cloud/admin/waitlist',
      headers: adminHeaders
    });
    expect(waitlist.json().waitlist).toHaveLength(1);

    const release = await app.inject({
      method: 'POST',
      url: `/v1/cloud/admin/batches/${batchId}/release`,
      headers: adminHeaders,
      payload: { count: 1 }
    });
    expect(release.json().release.granted).toEqual([registration.userId]);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/cloud/status',
      headers: { cookie: registration.cookie }
    });
    expect(status.json().cloud).toMatchObject({
      membership_status: 'ALPHA_ACTIVE',
      alpha_active: true,
      alpha_batch_id: batchId,
      alpha_grant_source: 'WAITLIST',
      quota: { source: 'ALPHA', total: 120, available: 120, remaining_ratio: 1 }
    });
    expect(status.json().cloud.quota.cycle_ends_at).toBeTruthy();
  });

  it('spends Alpha allowance on a platform reply and reports the remaining ratio', async () => {
    const { app, database, cookie } = await setup();
    const registration = await register(app, database, cookie, 'spend@example.com');
    const batch = await app.inject({
      method: 'POST',
      url: '/v1/cloud/admin/batches',
      headers: adminHeaders,
      payload: {
        name: 'spend',
        capacity: 5,
        quota_policy: { cycle_units: 4, cycle_days: 30 }
      }
    });
    await app.inject({
      method: 'POST',
      url: `/v1/cloud/admin/batches/${batch.json().batch.batch_id}/release`,
      headers: adminHeaders,
      payload: { count: 1 }
    });

    const characterId = await insertTestCharacter(database);
    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie: registration.cookie },
      payload: { character_id: characterId }
    });
    const turn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().conversation_id}/turns`,
      headers: { cookie: registration.cookie, 'idempotency-key': randomUUID() },
      payload: { usage_mode: 'PLATFORM', input: { type: 'text', text: '你好' } }
    });

    expect(turn.statusCode).toBe(201);
    expect(turn.json().cloud_quota).toMatchObject({
      source: 'ALPHA',
      total: 4,
      available: 3,
      remaining_ratio: 0.75
    });
    const ledger = await database.query<{
      quota_source: string;
      quota_units: number;
      purpose: string;
    }>(
      `SELECT quota_source, quota_units, purpose FROM model_usage_ledger
       WHERE user_id = $1`,
      [registration.userId]
    );
    expect(ledger.rows[0]).toMatchObject({
      quota_source: 'ALPHA',
      purpose: 'MAIN_REPLY'
    });
    expect(Number(ledger.rows[0]?.quota_units)).toBe(1);
  });

  it('pauses a member and blocks further platform replies', async () => {
    const { app, database, cookie } = await setup();
    const registration = await register(app, database, cookie, 'pause@example.com');
    const batch = await app.inject({
      method: 'POST',
      url: '/v1/cloud/admin/batches',
      headers: adminHeaders,
      payload: { name: 'pause', capacity: 5 }
    });
    await app.inject({
      method: 'POST',
      url: `/v1/cloud/admin/batches/${batch.json().batch.batch_id}/release`,
      headers: adminHeaders,
      payload: { count: 1 }
    });

    await app.inject({
      method: 'POST',
      url: `/v1/cloud/admin/members/${registration.userId}/transition`,
      headers: adminHeaders,
      payload: { transition: 'PAUSE' }
    });

    const characterId = await insertTestCharacter(database);
    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie: registration.cookie },
      payload: { character_id: characterId }
    });
    const turn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().conversation_id}/turns`,
      headers: { cookie: registration.cookie, 'idempotency-key': randomUUID() },
      payload: { usage_mode: 'PLATFORM', input: { type: 'text', text: '在吗' } }
    });

    expect(turn.statusCode).toBe(429);
    expect(turn.json().error.code).toBe('CLOUD_QUOTA_EXHAUSTED');
  });
});

describe('byok boundary', () => {
  it('spends neither Trial nor Alpha and stores no platform cost', async () => {
    const { app, database, cookie, userId } = await setup();
    const configuration = await app.inject({
      method: 'POST',
      url: '/v1/model-configurations',
      headers: { cookie },
      payload: {
        provider: 'openai',
        display_name: 'My Key',
        model_name: 'gpt-4o-mini',
        base_url: 'https://api.openai.com/v1',
        credential_id: 'local-credential-1',
        settings: { temperature: 0.8, max_output_tokens: 2048 }
      }
    });
    expect(configuration.statusCode).toBe(201);

    const characterId = await insertTestCharacter(database);
    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie },
      payload: { character_id: characterId }
    });
    const turn = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json().conversation_id}/turns`,
      headers: { cookie, 'idempotency-key': randomUUID() },
      payload: {
        usage_mode: 'BYOK',
        model_configuration_id:
          configuration.json().model_configuration_id,
        input: { type: 'text', text: '你好' },
        credential: {
          credential_id: 'local-credential-1',
          api_key: 'sk-user-owned-secret'
        }
      }
    });

    expect(turn.statusCode).toBe(201);
    expect(turn.json().cloud_quota).toBeUndefined();
    const quota = await database.query<{ remaining: number; reserved: number }>(
      `SELECT free_quota_remaining AS remaining, free_quota_reserved AS reserved
       FROM app_user WHERE user_id = $1`,
      [userId]
    );
    expect(Number(quota.rows[0]?.remaining)).toBe(30);
    expect(Number(quota.rows[0]?.reserved)).toBe(0);

    const ledger = await database.query<{
      quota_source: string;
      quota_units: number;
      cost: string | null;
    }>(
      `SELECT quota_source, quota_units, actual_cost_usd AS cost
       FROM model_usage_ledger WHERE user_id = $1`,
      [userId]
    );
    expect(ledger.rows[0]?.quota_source).toBe('BYOK');
    expect(Number(ledger.rows[0]?.quota_units)).toBe(0);
    // The user paid their own provider, so LiteTavern Cloud books no cost.
    expect(Number(ledger.rows[0]?.cost ?? 0)).toBe(0);
    // The key never reaches storage or logs.
    const dump = JSON.stringify(ledger.rows);
    expect(dump).not.toContain('sk-user-owned-secret');
  });
});

describe('support entry', () => {
  it('exposes a configurable support link and states the automation level', async () => {
    const { app, cookie } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cloud/support',
      headers: { cookie }
    });

    expect(response.json().support).toMatchObject({
      enabled: true,
      url: 'https://example.test/support',
      confirmation: 'MANUAL',
      thanks_list_enabled: true
    });
  });

  it('is disabled by default until an operator configures a URL', async () => {
    const { app, cookie } = await setup({
      support: {
        enabled: false,
        url: '',
        headline: '支持 LiteTavern',
        body: '',
        thanksListEnabled: false
      }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cloud/support',
      headers: { cookie }
    });

    expect(response.json().support.enabled).toBe(false);
  });
});

describe('export and sync', () => {
  it('exports a versioned bundle containing the user data and no secrets', async () => {
    const { app, database, cookie } = await setup();
    const characterId = await insertTestCharacter(database);
    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie },
      payload: { character_id: characterId }
    });
    await app.inject({
      method: 'POST',
      url: `/v1/characters/${characterId}/memories`,
      headers: { cookie },
      payload: { content: '第一次一起看星星' }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/cloud/export',
      headers: { cookie }
    });

    const bundle = response.json();
    expect(bundle.format).toBe('litetavern.export');
    expect(bundle.format_version).toBe('1.0.0');
    expect(bundle.exported_at).toBeTruthy();
    expect(bundle.data_types).toEqual(
      expect.arrayContaining(['characters', 'conversations', 'messages', 'memories'])
    );
    expect(bundle.conversations).toHaveLength(1);
    expect(bundle.conversations[0].conversation_id).toBe(
      conversation.json().conversation_id
    );
    expect(bundle.memories[0].content).toBe('第一次一起看星星');
    expect(JSON.stringify(bundle)).not.toContain('api_key');
  });

  it('records a retryable sync checkpoint per device', async () => {
    const { app, cookie } = await setup();

    const failed = await app.inject({
      method: 'POST',
      url: '/v1/cloud/sync/checkpoint',
      headers: { cookie },
      payload: {
        device_key: 'device-a',
        status: 'FAILED',
        client_revision: 3,
        pending_count: 2,
        error_code: 'NETWORK_OFFLINE'
      }
    });
    expect(failed.json().sync).toMatchObject({
      status: 'FAILED',
      pending_count: 2,
      last_error_code: 'NETWORK_OFFLINE'
    });

    const retried = await app.inject({
      method: 'POST',
      url: '/v1/cloud/sync/checkpoint',
      headers: { cookie },
      payload: {
        device_key: 'device-a',
        status: 'SYNCED',
        client_revision: 4,
        pending_count: 0
      }
    });
    expect(retried.json().sync).toMatchObject({
      status: 'SYNCED',
      pending_count: 0
    });
    expect(retried.json().sync.last_synced_at).toBeTruthy();

    const devices = await app.inject({
      method: 'GET',
      url: '/v1/cloud/sync',
      headers: { cookie }
    });
    expect(devices.json().devices).toHaveLength(1);
  });

  it('flags a device that checkpoints behind what it already acknowledged', async () => {
    const { app, cookie } = await setup();
    await app.inject({
      method: 'POST',
      url: '/v1/cloud/sync/checkpoint',
      headers: { cookie },
      payload: { device_key: 'device-b', status: 'SYNCED', client_revision: 10 }
    });

    const stale = await app.inject({
      method: 'POST',
      url: '/v1/cloud/sync/checkpoint',
      headers: { cookie },
      payload: { device_key: 'device-b', status: 'SYNCED', client_revision: 4 }
    });

    expect(stale.json().sync.stale).toBe(true);
    expect(stale.json().sync.conflict_count).toBe(1);
  });
});

describe('health and degradation', () => {
  it('advertises cloud availability so the client can degrade deliberately', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.json()).toMatchObject({
      status: 'ok',
      cloud: { stage: 'ALPHA', platform_models: true }
    });
  });
});
