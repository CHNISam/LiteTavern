import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import {
  finalizeFreeQuota,
  getFreeQuota,
  initializeFreeQuota,
  releaseFreeQuota,
  reserveFreeQuota
} from './free-quota.js';

let database: PomChatDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function setup(initialCount = 30) {
  database = await createDatabase({ dataDir: 'memory://' });
  const userId = randomUUID();
  await database.query(`INSERT INTO app_user (user_id) VALUES ($1)`, [userId]);
  await initializeFreeQuota(database, userId, initialCount);
  return { database, userId };
}

describe('free quota account', () => {
  it('initializes a new anonymous user once with 30 replies', async () => {
    const { database, userId } = await setup();
    expect(await getFreeQuota(database, userId)).toMatchObject({
      total: 30,
      remaining: 30,
      reserved: 0,
      available: 30
    });

    await initializeFreeQuota(database, userId, 30);
    expect(await getFreeQuota(database, userId)).toMatchObject({
      total: 30,
      remaining: 30,
      reserved: 0,
      available: 30
    });
    const grants = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM free_quota_ledger
       WHERE user_id = $1 AND action_type = 'GRANT'`,
      [userId]
    );
    expect(grants.rows[0]?.count).toBe(1);
  });

  it('deducts exactly once only after a successful reply', async () => {
    const { database, userId } = await setup();
    expect((await reserveFreeQuota(database, userId, 'request-success')).acquired).toBe(true);
    expect(await getFreeQuota(database, userId)).toMatchObject({
      remaining: 30,
      reserved: 1,
      available: 29
    });

    const first = await finalizeFreeQuota(database, {
      userId,
      requestId: 'request-success',
      provider: 'groq',
      model: 'configured-groq-model'
    });
    const replay = await finalizeFreeQuota(database, {
      userId,
      requestId: 'request-success',
      provider: 'groq',
      model: 'configured-groq-model'
    });

    expect(first.remaining).toBe(29);
    expect(replay.remaining).toBe(29);
    expect(await getFreeQuota(database, userId)).toMatchObject({
      remaining: 29,
      reserved: 0,
      available: 29
    });
    const consumes = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM free_quota_ledger
       WHERE user_id = $1 AND request_id = $2 AND action_type = 'CONSUME'`,
      [userId, 'request-success']
    );
    expect(consumes.rows[0]?.count).toBe(1);
  });

  it('releases a failed request without deducting quota', async () => {
    const { database, userId } = await setup();
    await reserveFreeQuota(database, userId, 'request-failed');
    await releaseFreeQuota(database, {
      userId,
      requestId: 'request-failed',
      provider: 'groq',
      model: 'configured-groq-model',
      failureCode: 'PROVIDER_TIMEOUT'
    });

    expect(await getFreeQuota(database, userId)).toMatchObject({
      remaining: 30,
      reserved: 0,
      available: 30
    });
  });

  it('never reserves more concurrent requests than the remaining balance', async () => {
    const { database, userId } = await setup(1);
    const results = await Promise.allSettled([
      reserveFreeQuota(database, userId, 'parallel-a'),
      reserveFreeQuota(database, userId, 'parallel-b')
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await getFreeQuota(database, userId)).toMatchObject({
      remaining: 1,
      reserved: 1,
      available: 0
    });
  });

  it('does not reserve twice for the same request id', async () => {
    const { database, userId } = await setup();
    const first = await reserveFreeQuota(database, userId, 'same-request');
    const second = await reserveFreeQuota(database, userId, 'same-request');

    expect(first).toMatchObject({ acquired: true, replayed: false });
    expect(second).toMatchObject({ acquired: false, replayed: true });
    expect(await getFreeQuota(database, userId)).toMatchObject({
      remaining: 30,
      reserved: 1,
      available: 29
    });
  });
});
