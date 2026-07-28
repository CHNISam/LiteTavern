import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import type { DbExecutor } from './quota.js';

/**
 * The LiteTavern Cloud v0.1.0 Alpha capacity plan.
 *
 * v9 gave each batch its own capacity, which was enough while Alpha had no ceiling.
 * The v0.1.0 operating decision adds one: 30 seats for this stage, released in two
 * waves of 10 and 20, with the second wave opened by an operator and never by a date.
 *
 * The number a grant is actually checked against is `released_capacity`, not
 * `total_capacity`. Before the unlock those are 10 and 30; afterwards both are 30.
 * Keeping the check on a single stored number is what makes "no overshoot" a
 * property of the data rather than of the call sites.
 *
 * 30 is this stage's ceiling, not a permanent Alpha headcount. Growing beyond it is a
 * new operating decision: it means editing the plan row, which is audited, and not
 * something any code path here does on its own.
 */

export const DEFAULT_PLAN_KEY = 'v0.1.0';

export interface AlphaPlan {
  plan_key: string;
  total_capacity: number;
  batch_1_capacity: number;
  batch_2_capacity: number;
  released_capacity: number;
  current_batch_no: number;
  batch_2_unlocked: boolean;
  batch_2_unlocked_at: string | null;
  batch_2_unlocked_by: string | null;
  paused: boolean;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  plan_key: string;
  total_capacity: number;
  batch_1_capacity: number;
  batch_2_capacity: number;
  released_capacity: number;
  current_batch_no: number;
  batch_2_unlocked: boolean;
  batch_2_unlocked_at: string | null;
  batch_2_unlocked_by: string | null;
  paused: boolean;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PLAN = `
  SELECT plan_key, total_capacity, batch_1_capacity, batch_2_capacity,
         released_capacity, current_batch_no, batch_2_unlocked,
         batch_2_unlocked_at, batch_2_unlocked_by, paused, paused_reason,
         created_at, updated_at
  FROM alpha_program_plan
  WHERE plan_key = $1`;

function toPlan(row: PlanRow): AlphaPlan {
  return {
    ...row,
    total_capacity: Number(row.total_capacity),
    batch_1_capacity: Number(row.batch_1_capacity),
    batch_2_capacity: Number(row.batch_2_capacity),
    released_capacity: Number(row.released_capacity),
    current_batch_no: Number(row.current_batch_no)
  };
}

export async function getPlan(
  database: DbExecutor,
  planKey = DEFAULT_PLAN_KEY
): Promise<AlphaPlan> {
  const result = await database.query<PlanRow>(SELECT_PLAN, [planKey]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError(
      'RESOURCE_NOT_FOUND',
      'Alpha 名额计划尚未初始化。',
      404
    );
  }
  return toPlan(row);
}

/**
 * Live seat accounting.
 *
 * A seat is held by a GRANTED row in alpha_grant. Revoking, ending or reclaiming a
 * grant flips it to REVOKED, which frees the seat immediately — that is what makes
 * "reclaim and re-issue" work without touching capacity numbers.
 */
export interface SeatUsage {
  released: number;
  total: number;
  /** Grants currently held, across every batch of the plan. */
  assigned: number;
  /** Held seats whose holder has actually entered Alpha. */
  activated: number;
  /** Held seats not yet entered. */
  granted_not_activated: number;
  remaining: number;
  suspended: number;
  ended: number;
  waitlist: number;
}

export async function getSeatUsage(
  database: DbExecutor,
  planKey = DEFAULT_PLAN_KEY
): Promise<SeatUsage> {
  const plan = await getPlan(database, planKey);
  const assigned = await countActiveGrants(database);

  const membership = await database.query<{
    membership_status: string;
    count: number;
  }>(
    `SELECT membership_status, COUNT(*)::int AS count
     FROM cloud_membership
     GROUP BY membership_status`
  );
  const counts = new Map(
    membership.rows.map((row) => [row.membership_status, Number(row.count)])
  );

  const activated = counts.get('ALPHA_ACTIVE') ?? 0;
  const grantedOnly = counts.get('ALPHA_GRANTED') ?? 0;

  return {
    released: plan.released_capacity,
    total: plan.total_capacity,
    assigned,
    activated,
    granted_not_activated: grantedOnly,
    remaining: Math.max(0, plan.released_capacity - assigned),
    suspended: counts.get('ALPHA_PAUSED') ?? 0,
    ended: counts.get('ALPHA_ENDED') ?? 0,
    waitlist: counts.get('REGISTERED_WAITLIST') ?? 0
  };
}

/** Live grants across the whole program — the number the released ceiling caps. */
export async function countActiveGrants(database: DbExecutor): Promise<number> {
  const result = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM alpha_grant WHERE status = 'GRANTED'`
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Re-reads the plan inside the caller's transaction with a row lock, so two
 * simultaneous grants cannot both read "9 seats used" and both succeed.
 *
 * `FOR UPDATE` on the single plan row serialises every seat-consuming operation in
 * the program. At 30 seats that is free; it is also the only lock that makes the
 * released-capacity check trustworthy under concurrency.
 */
export async function lockPlanForUpdate(
  transaction: DbExecutor,
  planKey = DEFAULT_PLAN_KEY
): Promise<AlphaPlan> {
  const result = await transaction.query<PlanRow>(
    `${SELECT_PLAN} FOR UPDATE`,
    [planKey]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('RESOURCE_NOT_FOUND', 'Alpha 名额计划尚未初始化。', 404);
  }
  return toPlan(row);
}

export type CapacityAuditAction =
  | 'GRANT'
  | 'SUSPEND'
  | 'RESUME'
  | 'REVOKE'
  | 'RECLAIM'
  | 'ACTIVATE'
  | 'BATCH_2_UNLOCK'
  | 'READINESS_CONFIRMED'
  | 'PLAN_UPDATED';

export interface CapacityAuditInput {
  action: CapacityAuditAction;
  actor: string;
  userId?: string | null;
  batchNo?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
  planKey?: string;
}

/**
 * Records one capacity-affecting action. Written inside the caller's transaction so
 * an audit row and the change it describes commit or roll back together.
 */
export async function recordCapacityAudit(
  executor: DbExecutor,
  input: CapacityAuditInput
): Promise<void> {
  await executor.query(
    `INSERT INTO alpha_capacity_audit (
       audit_id, plan_key, action, actor, user_id, batch_no, reason, detail_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      input.planKey ?? DEFAULT_PLAN_KEY,
      input.action,
      input.actor,
      input.userId ?? null,
      input.batchNo ?? null,
      input.reason ?? null,
      JSON.stringify(input.detail ?? {})
    ]
  );
}

export interface CapacityAuditEntry {
  audit_id: string;
  action: CapacityAuditAction;
  actor: string;
  user_id: string | null;
  batch_no: number | null;
  reason: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function listCapacityAudit(
  database: PomChatDatabase,
  options: { userId?: string; limit?: number; planKey?: string } = {}
): Promise<CapacityAuditEntry[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const result = await database.query<{
    audit_id: string;
    action: CapacityAuditAction;
    actor: string;
    user_id: string | null;
    batch_no: number | null;
    reason: string | null;
    detail_json: Record<string, unknown> | null;
    created_at: string;
  }>(
    `SELECT audit_id, action, actor, user_id, batch_no, reason,
            detail_json, created_at
     FROM alpha_capacity_audit
     WHERE plan_key = $1
       AND ($2::uuid IS NULL OR user_id = $2::uuid)
     ORDER BY created_at DESC
     LIMIT $3`,
    [options.planKey ?? DEFAULT_PLAN_KEY, options.userId ?? null, limit]
  );
  return result.rows.map((row) => ({
    audit_id: row.audit_id,
    action: row.action,
    actor: row.actor,
    user_id: row.user_id,
    batch_no: row.batch_no === null ? null : Number(row.batch_no),
    reason: row.reason,
    detail: row.detail_json ?? {},
    created_at: row.created_at
  }));
}

export interface UnlockResult {
  unlocked: boolean;
  /** True when the plan was already unlocked and this call changed nothing. */
  already_unlocked: boolean;
  plan: AlphaPlan;
}

/**
 * Raises the released ceiling from wave 1 to the full plan.
 *
 * The caller must have re-evaluated the readiness checklist server-side; this
 * function only performs the state change, transactionally and idempotently. A second
 * request returns `already_unlocked` and leaves the original evidence snapshot and
 * operator attribution untouched, so the audit trail records who actually made the
 * call rather than whoever retried last.
 */
export async function unlockBatchTwo(
  database: PomChatDatabase,
  input: {
    actor: string;
    evidence: Record<string, unknown>;
    planKey?: string;
  }
): Promise<UnlockResult> {
  const planKey = input.planKey ?? DEFAULT_PLAN_KEY;
  let alreadyUnlocked = false;

  await database.transaction(async (transaction) => {
    const plan = await lockPlanForUpdate(transaction, planKey);
    if (plan.batch_2_unlocked) {
      alreadyUnlocked = true;
      return;
    }

    const released = plan.batch_1_capacity + plan.batch_2_capacity;
    await transaction.query(
      `UPDATE alpha_program_plan
       SET batch_2_unlocked = TRUE,
           batch_2_unlocked_at = CURRENT_TIMESTAMP,
           batch_2_unlocked_by = $2,
           released_capacity = LEAST($3, total_capacity),
           current_batch_no = 2,
           unlock_evidence_json = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE plan_key = $1`,
      [planKey, input.actor, released, JSON.stringify(input.evidence)]
    );

    await recordCapacityAudit(transaction, {
      planKey,
      action: 'BATCH_2_UNLOCK',
      actor: input.actor,
      batchNo: 2,
      detail: {
        released_capacity_before: plan.released_capacity,
        released_capacity_after: Math.min(released, plan.total_capacity),
        evidence: input.evidence
      }
    });
  });

  return {
    unlocked: !alreadyUnlocked,
    already_unlocked: alreadyUnlocked,
    plan: await getPlan(database, planKey)
  };
}

/**
 * Frees a seat held by someone who never started testing or has stopped.
 *
 * This is the "reclaim and re-issue" path. It revokes the grant (freeing a seat
 * against `released_capacity`) and moves the member to ALPHA_ENDED. It never touches
 * the plan itself: re-issuing the freed seat is still a wave-1 grant, so reclaiming
 * can never become a back door to wave 2.
 */
export async function reclaimSeat(
  database: PomChatDatabase,
  input: {
    userId: string;
    actor: string;
    reason: string;
    planKey?: string;
  }
): Promise<{ reclaimed: boolean }> {
  let reclaimed = false;

  await database.transaction(async (transaction) => {
    const revoked = await transaction.query<{ grant_id: string; batch_no: number | null }>(
      `UPDATE alpha_grant
       SET status = 'REVOKED',
           revoked_at = CURRENT_TIMESTAMP,
           revoked_reason = $2,
           reclaimed_at = CURRENT_TIMESTAMP,
           reclaimed_by = $3
       WHERE user_id = $1 AND status = 'GRANTED'
       RETURNING grant_id, batch_no`,
      [input.userId, input.reason, input.actor]
    );
    if (revoked.rows.length === 0) return;
    reclaimed = true;

    await transaction.query(
      `UPDATE cloud_membership
       SET membership_status = 'ALPHA_ENDED',
           ended_at = CURRENT_TIMESTAMP,
           revoked_reason = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
         AND membership_status IN ('ALPHA_GRANTED', 'ALPHA_ACTIVE', 'ALPHA_PAUSED')`,
      [input.userId, input.reason]
    );
    await transaction.query(
      `UPDATE cloud_quota_cycle
       SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [input.userId]
    );

    await recordCapacityAudit(transaction, {
      planKey: input.planKey ?? DEFAULT_PLAN_KEY,
      action: 'RECLAIM',
      actor: input.actor,
      userId: input.userId,
      batchNo: revoked.rows[0]?.batch_no ?? null,
      reason: input.reason,
      detail: { grant_id: revoked.rows[0]?.grant_id ?? null }
    });
  });

  return { reclaimed };
}
