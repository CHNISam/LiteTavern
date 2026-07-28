import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { loadCloudConfig, type CloudConfig } from './config.js';
import { estimateCostUsd, recordUsage, assertGlobalBudget } from './cost.js';
import { createBatch, getBatchMetrics, releaseUsers, updateBatch } from './batches.js';
import {
  activateAlpha,
  ensureMembership,
  grantAlpha,
  joinWaitlist,
  listWaitlist,
  onRegistrationCompleted,
  readBatchPolicy,
  transitionAlpha
} from './membership.js';
import { markFoundingSupporter } from './supporter.js';
import {
  ensureCurrentCycle,
  finalizeQuota,
  releaseQuota,
  reserveQuota,
  resolveQuota,
  unitsForRequest
} from './quota.js';
import { initializeFreeQuota } from '../free-quota.js';

let database: PomChatDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
  const base = loadCloudConfig({});
  return { ...base, ...overrides };
}

async function setup() {
  database = await createDatabase({ dataDir: 'memory://' });
  return database;
}

async function createUser(
  db: PomChatDatabase,
  options: { email?: string; trial?: number } = {}
): Promise<string> {
  const userId = randomUUID();
  await db.query(`INSERT INTO app_user (user_id, email) VALUES ($1, $2)`, [
    userId,
    options.email ?? null
  ]);
  await initializeFreeQuota(db, userId, options.trial ?? 30);
  // Everyone starts anonymous on Trial, exactly as the product does; a test that
  // cares about registration moves the membership forward explicitly.
  await ensureMembership(db, userId, false);
  return userId;
}

describe('cloud membership', () => {
  it('places a registered user on the waitlist without granting Alpha', async () => {
    const db = await setup();
    const userId = await createUser(db, { email: 'a@example.com' });

    const membership = await onRegistrationCompleted(db, userId);

    expect(membership.status).toBe('REGISTERED_WAITLIST');
    expect(membership.batchId).toBeNull();
    const cycles = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM cloud_quota_cycle WHERE user_id = $1`,
      [userId]
    );
    expect(cycles.rows[0]?.count).toBe(0);
  });

  it('joins the waitlist idempotently and keeps the original queue position', async () => {
    const db = await setup();
    const userId = await createUser(db, { email: 'b@example.com' });

    const first = await joinWaitlist(db, userId, 'app');
    const second = await joinWaitlist(db, userId, 'app');

    expect(first.joined).toBe(true);
    expect(second.joined).toBe(false);
    expect(second.membership.waitlistJoinedAt).toStrictEqual(
      first.membership.waitlistJoinedAt
    );
  });

  it('refuses the waitlist to an anonymous user', async () => {
    const db = await setup();
    const userId = await createUser(db);

    await expect(joinWaitlist(db, userId)).rejects.toMatchObject({
      code: 'REGISTRATION_REQUIRED'
    });
  });
});

describe('alpha batches', () => {
  it('enforces the batch capacity set by the operator', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await createBatch(db, cloud, { name: 'wave-1', capacity: 2 });
    const users = await Promise.all([
      createUser(db, { email: 'c1@example.com' }),
      createUser(db, { email: 'c2@example.com' }),
      createUser(db, { email: 'c3@example.com' })
    ]);
    for (const userId of users) await joinWaitlist(db, userId);

    const release = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      count: 3
    });

    expect(release.granted).toHaveLength(2);
    expect(release.skipped[0]?.reason).toBe('BATCH_FULL');
    expect(release.remaining_capacity).toBe(0);
  });

  it('gives Founding Supporters priority without making payment the only route', async () => {
    const db = await setup();
    const cloud = config();
    const early = await createUser(db, { email: 'early@example.com' });
    await joinWaitlist(db, early);
    const supporter = await createUser(db, { email: 'supporter@example.com' });
    await joinWaitlist(db, supporter);
    await markFoundingSupporter(db, { userId: supporter, anonymous: true });

    // Supporter joined later but is released first.
    const ordered = await listWaitlist(db);
    expect(ordered[0]?.userId).toBe(supporter);

    const batch = await createBatch(db, cloud, { name: 'wave-2', capacity: 1 });
    const release = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      count: 1
    });
    expect(release.granted).toEqual([supporter]);

    const grant = await db.query<{ grant_source: string }>(
      `SELECT grant_source FROM alpha_grant WHERE user_id = $1`,
      [supporter]
    );
    expect(grant.rows[0]?.grant_source).toBe('SUPPORTER_PRIORITY');

    // The ordinary waitlist user still gets in through the next batch.
    const next = await createBatch(db, cloud, { name: 'wave-3', capacity: 1 });
    const secondRelease = await releaseUsers(db, cloud, {
      batchId: next.batch_id,
      count: 1
    });
    expect(secondRelease.granted).toEqual([early]);
  });

  it('admits a targeted invite that never entered the waitlist', async () => {
    const db = await setup();
    const cloud = config();
    const invited = await createUser(db, { email: 'invited@example.com' });
    const batch = await createBatch(db, cloud, { name: 'invite', capacity: 5 });

    const release = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: [invited]
    });

    expect(release.granted).toEqual([invited]);
    const grant = await db.query<{ grant_source: string }>(
      `SELECT grant_source FROM alpha_grant WHERE user_id = $1`,
      [invited]
    );
    expect(grant.rows[0]?.grant_source).toBe('DIRECT_INVITE');
  });

  it('grants Alpha at most once, even under concurrent releases', async () => {
    const db = await setup();
    const cloud = config();
    const userId = await createUser(db, { email: 'once@example.com' });
    await joinWaitlist(db, userId);
    const batch = await createBatch(db, cloud, { name: 'once', capacity: 10 });
    const policy = await readBatchPolicy(
      db,
      batch.batch_id,
      cloud.defaultAlphaPolicy
    );

    const results = await Promise.all([
      grantAlpha(db, {
        userId,
        batchId: batch.batch_id,
        grantSource: 'WAITLIST',
        policy
      }),
      grantAlpha(db, {
        userId,
        batchId: batch.batch_id,
        grantSource: 'WAITLIST',
        policy
      })
    ]);

    expect(results.filter((result) => result.granted)).toHaveLength(1);
    const grants = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM alpha_grant
       WHERE user_id = $1 AND status = 'GRANTED'`,
      [userId]
    );
    expect(grants.rows[0]?.count).toBe(1);

    // Granting reserves a seat but opens no cycle; entering Alpha opens exactly one,
    // and entering twice does not open a second.
    const beforeEntry = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM cloud_quota_cycle WHERE user_id = $1`,
      [userId]
    );
    expect(beforeEntry.rows[0]?.count).toBe(0);

    await activateAlpha(db, { userId, policy });
    const replay = await activateAlpha(db, { userId, policy });
    expect(replay.alreadyActive).toBe(true);

    const cycles = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM cloud_quota_cycle WHERE user_id = $1`,
      [userId]
    );
    expect(cycles.rows[0]?.count).toBe(1);
  });

  it('runs different batches on different quota policies', async () => {
    const db = await setup();
    const cloud = config();
    const small = await createBatch(db, cloud, {
      name: 'small',
      capacity: 1,
      quotaPolicy: { cycle_units: 10, cycle_days: 7 }
    });
    const large = await createBatch(db, cloud, {
      name: 'large',
      capacity: 1,
      quotaPolicy: { cycle_units: 500, cycle_days: 30 }
    });

    const smallUser = await createUser(db, { email: 's@example.com' });
    const largeUser = await createUser(db, { email: 'l@example.com' });
    await releaseUsers(db, cloud, {
      batchId: small.batch_id,
      userIds: [smallUser]
    });
    await releaseUsers(db, cloud, {
      batchId: large.batch_id,
      userIds: [largeUser]
    });
    await activateAlpha(db, {
      userId: smallUser,
      policy: await readBatchPolicy(db, small.batch_id, cloud.defaultAlphaPolicy)
    });
    await activateAlpha(db, {
      userId: largeUser,
      policy: await readBatchPolicy(db, large.batch_id, cloud.defaultAlphaPolicy)
    });

    const grants = await db.query<{ user_id: string; granted_units: number }>(
      `SELECT user_id, granted_units FROM cloud_quota_cycle`
    );
    const byUser = new Map(
      grants.rows.map((row) => [row.user_id, Number(row.granted_units)])
    );
    expect(byUser.get(smallUser)).toBe(10);
    expect(byUser.get(largeUser)).toBe(500);
  });

  it('stops further releases once a batch is paused', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await createBatch(db, cloud, { name: 'pausable', capacity: 5 });
    await updateBatch(db, cloud, batch.batch_id, { status: 'PAUSED' });
    const userId = await createUser(db, { email: 'paused@example.com' });

    await expect(
      releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] })
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('alpha quota', () => {
  async function alphaUser(db: PomChatDatabase, cloud: CloudConfig, units = 5) {
    const batch = await createBatch(db, cloud, {
      name: `batch-${randomUUID()}`,
      capacity: 10,
      quotaPolicy: { cycle_units: units, cycle_days: 30, daily_unit_limit: 0 }
    });
    const userId = await createUser(db, { email: `${randomUUID()}@example.com` });
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });
    const policy = await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy);
    // A released seat is not a running cycle: the user has to enter Alpha first.
    await activateAlpha(db, { userId, policy });
    return { userId, batchId: batch.batch_id, policy };
  }

  it('grants the cycle allowance exactly once', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 5);

    await ensureCurrentCycle(db, userId, policy);
    await ensureCurrentCycle(db, userId, policy);

    const grants = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM cloud_quota_ledger
       WHERE user_id = $1 AND action_type = 'GRANT'`,
      [userId]
    );
    expect(grants.rows[0]?.count).toBe(1);
  });

  it('spends Alpha allowance instead of the leftover Trial', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 5);

    const resolved = await resolveQuota(db, {
      userId,
      membershipStatus: 'ALPHA_ACTIVE',
      policy,
      trialEnabled: cloud.trialEnabled
    });

    expect(resolved.source).toBe('ALPHA');
    expect(resolved.total).toBe(5);
    expect(resolved.remainingRatio).toBe(1);
  });

  it('never over-deducts or goes negative under concurrency', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 1);
    const context = {
      userId,
      membershipStatus: 'ALPHA_ACTIVE' as const,
      policy,
      trialEnabled: cloud.trialEnabled,
      provider: 'groq',
      model: 'test-model'
    };

    const results = await Promise.allSettled([
      reserveQuota(db, { ...context, requestId: 'a' }),
      reserveQuota(db, { ...context, requestId: 'b' })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const cycle = await db.query<{ reserved: number; consumed: number }>(
      `SELECT reserved_units AS reserved, consumed_units AS consumed
       FROM cloud_quota_cycle WHERE user_id = $1`,
      [userId]
    );
    expect(Number(cycle.rows[0]?.reserved)).toBe(1);
    expect(Number(cycle.rows[0]?.consumed)).toBe(0);
  });

  it('releases the reservation when the request fails', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 3);
    const context = {
      userId,
      membershipStatus: 'ALPHA_ACTIVE' as const,
      policy,
      trialEnabled: cloud.trialEnabled,
      provider: 'groq',
      model: 'test-model',
      requestId: 'failing'
    };

    const reservation = await reserveQuota(db, context);
    const after = await releaseQuota(db, {
      ...context,
      source: 'ALPHA',
      units: reservation.units,
      cycleId: reservation.cycleId,
      failureCode: 'PROVIDER_TIMEOUT'
    });

    expect(after.available).toBe(3);
    expect(after.used).toBe(0);
  });

  it('deducts exactly once when a finalization is replayed', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 3);
    const context = {
      userId,
      membershipStatus: 'ALPHA_ACTIVE' as const,
      policy,
      trialEnabled: cloud.trialEnabled,
      provider: 'groq',
      model: 'test-model',
      requestId: 'settled'
    };

    const reservation = await reserveQuota(db, context);
    const settle = {
      ...context,
      source: 'ALPHA' as const,
      units: reservation.units,
      cycleId: reservation.cycleId
    };
    const first = await finalizeQuota(db, settle);
    const replay = await finalizeQuota(db, settle);

    expect(first.available).toBe(2);
    expect(replay.available).toBe(2);
    expect(replay.used).toBe(1);
  });

  it('rolls into the next cycle when the period ends, without carrying over by default', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 4);
    const context = {
      userId,
      membershipStatus: 'ALPHA_ACTIVE' as const,
      policy,
      trialEnabled: cloud.trialEnabled,
      provider: 'groq',
      model: 'test-model',
      requestId: 'spent'
    };
    const reservation = await reserveQuota(db, context);
    await finalizeQuota(db, {
      ...context,
      source: 'ALPHA',
      units: reservation.units,
      cycleId: reservation.cycleId
    });

    const later = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const next = await ensureCurrentCycle(db, userId, policy, later);

    expect(next.cycleNo).toBe(2);
    expect(next.total).toBe(4);
    expect(next.used).toBe(0);
    const cycles = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM cloud_quota_cycle
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId]
    );
    expect(cycles.rows[0]?.count).toBe(1);
  });

  it('applies a per-model multiplier from the batch policy', async () => {
    const policy = {
      cycleUnits: 100,
      cycleDays: 30,
      carryOver: false,
      maxUnitsPerRequest: 4,
      dailyUnitLimit: 0,
      userRateLimitPerMinute: 20,
      modelMultipliers: { 'groq:expensive-model': 3 }
    };
    expect(unitsForRequest(policy, 'groq', 'expensive-model')).toBe(3);
    expect(unitsForRequest(policy, 'groq', 'cheap-model')).toBe(1);
  });

  it('blocks a paused Alpha member from spending anything', async () => {
    const db = await setup();
    const cloud = config();
    const { userId, policy } = await alphaUser(db, cloud, 5);
    await transitionAlpha(db, userId, 'PAUSE');

    const resolved = await resolveQuota(db, {
      userId,
      membershipStatus: 'ALPHA_PAUSED',
      policy,
      trialEnabled: cloud.trialEnabled
    });

    expect(resolved.source).toBe('NONE');
    expect(resolved.available).toBe(0);
  });
});

describe('cost accounting and budget', () => {
  it('prices a call from the configured per-model rates', () => {
    const prices = {
      'groq:model-a': {
        inputPerMillion: 10,
        outputPerMillion: 20,
        cachedInputPerMillion: 1
      }
    };
    const cost = estimateCostUsd(prices, 'groq', 'model-a', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 200_000
    });
    // 800k fresh input @10 + 200k cached @1 + 500k output @20
    expect(cost).toBeCloseTo(8 + 0.2 + 10, 6);
  });

  it('keeps one cost row per request purpose', async () => {
    const db = await setup();
    const cloud = config({
      modelPrices: {
        'groq:m': {
          inputPerMillion: 1000,
          outputPerMillion: 1000,
          cachedInputPerMillion: 0
        }
      }
    });
    const userId = await createUser(db, { email: 'cost@example.com' });
    const requestId = randomUUID();

    for (const purpose of ['MAIN_REPLY', 'SUMMARY', 'MEMORY'] as const) {
      await recordUsage(db, cloud, {
        generationRequestId: requestId,
        userId,
        usageMode: 'PLATFORM',
        quotaSource: 'ALPHA',
        purpose,
        provider: 'groq',
        model: 'm',
        usage: { inputTokens: 1000, outputTokens: 1000 },
        quotaUnits: 1
      });
    }
    // A replayed finalization must update, not duplicate.
    await recordUsage(db, cloud, {
      generationRequestId: requestId,
      userId,
      usageMode: 'PLATFORM',
      quotaSource: 'ALPHA',
      purpose: 'MAIN_REPLY',
      provider: 'groq',
      model: 'm',
      usage: { inputTokens: 1000, outputTokens: 1000 },
      quotaUnits: 1
    });

    const rows = await db.query<{ purpose: string; cost: string }>(
      `SELECT purpose, actual_cost_usd AS cost FROM model_usage_ledger
       WHERE generation_request_id = $1 ORDER BY purpose`,
      [requestId]
    );
    expect(rows.rows.map((row) => row.purpose)).toEqual([
      'MAIN_REPLY',
      'MEMORY',
      'SUMMARY'
    ]);
    // 1000 input + 1000 output tokens at 1000 USD / 1M tokens each.
    expect(Number(rows.rows[0]?.cost)).toBeCloseTo(2, 6);
  });

  it('trips the global budget circuit breaker once the ceiling is reached', async () => {
    const db = await setup();
    const cloud = config({
      globalMonthlyBudgetUsd: 0.001,
      modelPrices: {
        'groq:m': {
          inputPerMillion: 1000,
          outputPerMillion: 1000,
          cachedInputPerMillion: 0
        }
      }
    });
    const userId = await createUser(db, { email: 'budget@example.com' });

    await assertGlobalBudget(db, cloud);
    await recordUsage(db, cloud, {
      generationRequestId: randomUUID(),
      userId,
      usageMode: 'PLATFORM',
      quotaSource: 'ALPHA',
      purpose: 'MAIN_REPLY',
      provider: 'groq',
      model: 'm',
      usage: { inputTokens: 1000, outputTokens: 1000 },
      quotaUnits: 1
    });

    await expect(assertGlobalBudget(db, cloud)).rejects.toMatchObject({
      code: 'CLOUD_BUDGET_EXHAUSTED'
    });
  });

  it('reports per-batch cost and activity for the operator', async () => {
    const db = await setup();
    const cloud = config({
      modelPrices: {
        'groq:m': {
          inputPerMillion: 1000,
          outputPerMillion: 0,
          cachedInputPerMillion: 0
        }
      }
    });
    const batch = await createBatch(db, cloud, {
      name: 'metrics',
      capacity: 5,
      budgetLimitUsd: 10
    });
    const userId = await createUser(db, { email: 'metrics@example.com' });
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });
    await activateAlpha(db, {
      userId,
      policy: await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy)
    });
    await recordUsage(db, cloud, {
      generationRequestId: randomUUID(),
      userId,
      usageMode: 'PLATFORM',
      quotaSource: 'ALPHA',
      purpose: 'MAIN_REPLY',
      provider: 'groq',
      model: 'm',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      quotaUnits: 1,
      batchId: batch.batch_id
    });

    const metrics = await getBatchMetrics(db, cloud, batch.batch_id);

    expect(metrics.granted).toBe(1);
    expect(metrics.active).toBe(1);
    expect(metrics.costUsd).toBeCloseTo(1000, 3);
    expect(metrics.withinBudget).toBe(false);
  });
});

describe('founding supporter', () => {
  it('marks a supporter idempotently on the payment reference', async () => {
    const db = await setup();
    const userId = await createUser(db, { email: 'fs@example.com' });

    const first = await markFoundingSupporter(db, {
      userId,
      externalReference: 'order-1'
    });
    const second = await markFoundingSupporter(db, {
      userId,
      externalReference: 'order-1'
    });

    expect(first.marked).toBe(true);
    expect(second.marked).toBe(false);
    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM founding_supporter`
    );
    expect(rows.rows[0]?.count).toBe(1);
  });
});
