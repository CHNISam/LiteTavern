import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import {
  resolveAlphaPolicy,
  serializeAlphaPolicy,
  type AlphaQuotaPolicy,
  type CloudConfig
} from './config.js';
import { batchCostSummary, type BatchCostSummary } from './cost.js';
import { recordCloudEvent } from './events.js';
import {
  grantAlpha,
  isFoundingSupporter,
  listWaitlist,
  type GrantSource
} from './membership.js';

/**
 * Alpha batches.
 *
 * Alpha has no fixed lifetime headcount. Capacity is decided per batch by the
 * operator from the things that actually constrain it — model budget, observed
 * per-user cost, stability, support load — and stored on the batch row. Nothing here
 * hardcodes how many people an Alpha wave admits.
 */

export interface AlphaBatch {
  batch_id: string;
  name: string;
  capacity: number;
  status: 'OPEN' | 'PAUSED' | 'CLOSED';
  granted: number;
  remaining: number;
  quota_policy: ReturnType<typeof serializeAlphaPolicy>;
  budget_limit_usd: number | null;
  notes: string | null;
  created_at: string;
}

interface BatchRow {
  batch_id: string;
  name: string;
  capacity: number;
  status: 'OPEN' | 'PAUSED' | 'CLOSED';
  quota_policy_json: unknown;
  budget_limit_usd: string | number | null;
  notes: string | null;
  created_at: string;
  granted: number;
}

function toBatch(row: BatchRow, fallback: AlphaQuotaPolicy): AlphaBatch {
  const capacity = Number(row.capacity);
  const granted = Number(row.granted);
  return {
    batch_id: row.batch_id,
    name: row.name,
    capacity,
    status: row.status,
    granted,
    remaining: Math.max(0, capacity - granted),
    quota_policy: serializeAlphaPolicy(
      resolveAlphaPolicy(fallback, row.quota_policy_json)
    ),
    budget_limit_usd:
      row.budget_limit_usd === null ? null : Number(row.budget_limit_usd),
    notes: row.notes,
    created_at: row.created_at
  };
}

const SELECT_BATCH = `
  SELECT b.batch_id, b.name, b.capacity, b.status, b.quota_policy_json,
         b.budget_limit_usd, b.notes, b.created_at,
         COALESCE(g.granted, 0)::int AS granted
  FROM alpha_batch b
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS granted FROM alpha_grant
    WHERE batch_id = b.batch_id AND status = 'GRANTED'
  ) g ON TRUE`;

export interface CreateBatchInput {
  name: string;
  capacity: number;
  quotaPolicy?: Record<string, unknown>;
  budgetLimitUsd?: number;
  notes?: string;
  createdBy?: string;
}

export async function createBatch(
  database: PomChatDatabase,
  config: CloudConfig,
  input: CreateBatchInput
): Promise<AlphaBatch> {
  const batchId = randomUUID();
  const policy = resolveAlphaPolicy(
    config.defaultAlphaPolicy,
    input.quotaPolicy ?? {}
  );
  await database.query(
    `INSERT INTO alpha_batch (
       batch_id, name, capacity, status, quota_policy_json,
       budget_limit_usd, notes, created_by
     ) VALUES ($1, $2, $3, 'OPEN', $4::jsonb, $5, $6, $7)`,
    [
      batchId,
      input.name,
      input.capacity,
      JSON.stringify(serializeAlphaPolicy(policy)),
      input.budgetLimitUsd ?? null,
      input.notes ?? null,
      input.createdBy ?? null
    ]
  );
  await recordCloudEvent(database, 'alpha_batch_created', {
    properties: {
      batch_id: batchId,
      capacity: input.capacity,
      cycle_units: policy.cycleUnits,
      cycle_days: policy.cycleDays
    }
  });
  const created = await getBatch(database, config, batchId);
  if (!created) throw new AppError('INTERNAL_ERROR', '批次创建失败。', 500);
  return created;
}

export async function getBatch(
  database: PomChatDatabase,
  config: CloudConfig,
  batchId: string
): Promise<AlphaBatch | null> {
  const result = await database.query<BatchRow>(
    `${SELECT_BATCH} WHERE b.batch_id = $1`,
    [batchId]
  );
  return result.rows[0]
    ? toBatch(result.rows[0], config.defaultAlphaPolicy)
    : null;
}

export async function listBatches(
  database: PomChatDatabase,
  config: CloudConfig
): Promise<AlphaBatch[]> {
  const result = await database.query<BatchRow>(
    `${SELECT_BATCH} ORDER BY b.created_at DESC`
  );
  return result.rows.map((row) => toBatch(row, config.defaultAlphaPolicy));
}

export interface UpdateBatchInput {
  capacity?: number;
  status?: 'OPEN' | 'PAUSED' | 'CLOSED';
  quotaPolicy?: Record<string, unknown>;
  budgetLimitUsd?: number;
  notes?: string;
}

/**
 * Adjusts a batch mid-flight — most importantly `status: 'PAUSED'`, which stops
 * further releases without touching anyone already inside the batch.
 */
export async function updateBatch(
  database: PomChatDatabase,
  config: CloudConfig,
  batchId: string,
  input: UpdateBatchInput
): Promise<AlphaBatch> {
  const current = await getBatch(database, config, batchId);
  if (!current) throw new AppError('RESOURCE_NOT_FOUND', '批次不存在。', 404);

  const policy = input.quotaPolicy
    ? resolveAlphaPolicy(
        resolveAlphaPolicy(config.defaultAlphaPolicy, current.quota_policy),
        input.quotaPolicy
      )
    : null;

  await database.query(
    `UPDATE alpha_batch
     SET capacity = COALESCE($2, capacity),
         status = COALESCE($3, status),
         quota_policy_json = COALESCE($4::jsonb, quota_policy_json),
         budget_limit_usd = COALESCE($5, budget_limit_usd),
         notes = COALESCE($6, notes),
         updated_at = CURRENT_TIMESTAMP
     WHERE batch_id = $1`,
    [
      batchId,
      input.capacity ?? null,
      input.status ?? null,
      policy ? JSON.stringify(serializeAlphaPolicy(policy)) : null,
      input.budgetLimitUsd ?? null,
      input.notes ?? null
    ]
  );
  const updated = await getBatch(database, config, batchId);
  if (!updated) throw new AppError('RESOURCE_NOT_FOUND', '批次不存在。', 404);
  return updated;
}

export interface ReleaseResult {
  batch_id: string;
  granted: string[];
  skipped: { user_id: string; reason: string }[];
  remaining_capacity: number;
}

export interface ReleaseInput {
  batchId: string;
  /** Explicit targets — the direct-invite channel. */
  userIds?: string[];
  /** Take the next N from the waitlist in priority order. */
  count?: number;
  grantSource?: GrantSource;
  grantedBy?: string;
}

/**
 * Releases users into a batch.
 *
 * Three channels share this one path: an explicit `user_ids` list (targeted invite or
 * admin grant), and a `count` pull from the waitlist, which is ordered Founding
 * Supporters first and then longest-waiting. Supporter priority only reorders the
 * queue — it never becomes the sole way in, and it grants no extra allowance.
 *
 * Each individual release goes through `grantAlpha`, which is idempotent and
 * capacity-checked, so a repeated or concurrent release cannot double-grant or
 * overshoot the batch.
 */
export async function releaseUsers(
  database: PomChatDatabase,
  config: CloudConfig,
  input: ReleaseInput
): Promise<ReleaseResult> {
  const batch = await getBatch(database, config, input.batchId);
  if (!batch) throw new AppError('RESOURCE_NOT_FOUND', '批次不存在。', 404);
  if (batch.status !== 'OPEN') {
    throw new AppError('BATCH_NOT_OPEN', '该批次当前未开放放行。', 409);
  }

  const policy = resolveAlphaPolicy(
    config.defaultAlphaPolicy,
    batch.quota_policy
  );

  let targets: string[];
  let defaultSource: GrantSource;
  if (input.userIds) {
    targets = [...new Set(input.userIds)];
    defaultSource = 'DIRECT_INVITE';
  } else {
    const candidates = await listWaitlist(database, batch.remaining + 50);
    targets = candidates.slice(0, input.count ?? 0).map((item) => item.userId);
    defaultSource = 'WAITLIST';
  }

  const granted: string[] = [];
  const skipped: { user_id: string; reason: string }[] = [];

  for (const userId of targets) {
    const supporter = await isFoundingSupporter(database, userId);
    const grantSource =
      input.grantSource ??
      (supporter && defaultSource === 'WAITLIST'
        ? 'SUPPORTER_PRIORITY'
        : defaultSource);

    const result = await grantAlpha(database, {
      userId,
      batchId: input.batchId,
      grantSource,
      policy,
      ...(input.grantedBy ? { grantedBy: input.grantedBy } : {})
    });

    if (!result.granted) {
      skipped.push({ user_id: userId, reason: result.reason ?? 'UNKNOWN' });
      if (result.reason === 'BATCH_FULL') break;
      continue;
    }

    granted.push(userId);
    const properties: Record<string, string | number | boolean | null> = {
      batch_id: input.batchId,
      grant_source: grantSource,
      founding_supporter: supporter,
      waited_seconds: result.waitedSeconds ?? -1
    };
    await recordCloudEvent(database, 'alpha_granted', { userId, properties });
    await recordCloudEvent(database, 'alpha_activated', { userId, properties });
    await recordCloudEvent(database, 'alpha_quota_granted', {
      userId,
      properties: {
        batch_id: input.batchId,
        cycle_units: policy.cycleUnits,
        cycle_days: policy.cycleDays
      }
    });
    if (grantSource === 'DIRECT_INVITE') {
      await recordCloudEvent(database, 'alpha_invitation_sent', {
        userId,
        properties
      });
    }
  }

  const refreshed = await getBatch(database, config, input.batchId);
  return {
    batch_id: input.batchId,
    granted,
    skipped,
    remaining_capacity: refreshed?.remaining ?? 0
  };
}

export interface BatchMetrics extends BatchCostSummary {
  capacity: number;
  granted: number;
  active: number;
  paused: number;
  ended: number;
  activationRate: number;
  budgetLimitUsd: number | null;
  withinBudget: boolean;
  averageCostPerUserUsd: number;
}

/** Everything an operator needs before deciding whether to open the next batch. */
export async function getBatchMetrics(
  database: PomChatDatabase,
  config: CloudConfig,
  batchId: string
): Promise<BatchMetrics> {
  const batch = await getBatch(database, config, batchId);
  if (!batch) throw new AppError('RESOURCE_NOT_FOUND', '批次不存在。', 404);

  const membership = await database.query<{
    membership_status: string;
    count: number;
  }>(
    `SELECT membership_status, COUNT(*)::int AS count
     FROM cloud_membership
     WHERE batch_id = $1
     GROUP BY membership_status`,
    [batchId]
  );
  const counts = new Map(
    membership.rows.map((row) => [row.membership_status, Number(row.count)])
  );

  const cost = await batchCostSummary(database, batchId);
  const active = counts.get('ALPHA_ACTIVE') ?? 0;
  const budgetLimit = batch.budget_limit_usd;

  return {
    ...cost,
    capacity: batch.capacity,
    granted: batch.granted,
    active,
    paused: counts.get('ALPHA_PAUSED') ?? 0,
    ended: counts.get('ALPHA_ENDED') ?? 0,
    activationRate: batch.granted === 0 ? 0 : cost.users / batch.granted,
    budgetLimitUsd: budgetLimit,
    withinBudget: budgetLimit === null ? true : cost.costUsd <= budgetLimit,
    averageCostPerUserUsd:
      cost.users === 0 ? 0 : Math.round((cost.costUsd / cost.users) * 1e8) / 1e8
  };
}
