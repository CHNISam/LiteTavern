import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import {
  finalizeFreeQuota,
  getFreeQuota,
  releaseFreeQuota,
  reserveFreeQuota
} from '../free-quota.js';
import type { AlphaQuotaPolicy } from './config.js';
import type { MembershipStatus } from './membership.js';

// Any object exposing `query` — the database itself or a transaction handle.
export interface DbExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

/**
 * Which pool pays for a model call.
 *  TRIAL — one-time LiteTavern Cloud Trial granted to a new (anonymous) identity.
 *  ALPHA — a released Alpha user's cycle allowance.
 *  BYOK  — the user's own key: never touches either pool.
 *  NONE  — no platform quota is available (waitlisted, paused, ended, exhausted).
 */
export type QuotaSource = 'TRIAL' | 'ALPHA' | 'BYOK' | 'NONE';

export interface QuotaSnapshot {
  source: QuotaSource;
  total: number;
  used: number;
  reserved: number;
  available: number;
  /** 0–1, rounded to 2 decimals; what the client renders as "剩余 68%". */
  remainingRatio: number;
  cycleId: string | null;
  cycleNo: number | null;
  cycleStartsAt: string | null;
  cycleEndsAt: string | null;
}

const EMPTY_SNAPSHOT: QuotaSnapshot = {
  source: 'NONE',
  total: 0,
  used: 0,
  reserved: 0,
  available: 0,
  remainingRatio: 0,
  cycleId: null,
  cycleNo: null,
  cycleStartsAt: null,
  cycleEndsAt: null
};

function ratio(available: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, available / total)) * 100) / 100;
}

/** How many quota units one request against `provider/model` costs. */
export function unitsForRequest(
  policy: AlphaQuotaPolicy,
  provider: string,
  model: string
): number {
  const multiplier =
    policy.modelMultipliers[`${provider}:${model}`] ??
    policy.modelMultipliers[model] ??
    policy.modelMultipliers[provider] ??
    1;
  return Math.min(
    Math.max(1, Math.ceil(multiplier)),
    Math.max(1, policy.maxUnitsPerRequest)
  );
}

interface CycleRow {
  cycle_id: string;
  cycle_no: number;
  starts_at: string;
  ends_at: string;
  granted_units: number;
  carried_units: number;
  consumed_units: number;
  reserved_units: number;
}

const SELECT_ACTIVE_CYCLE = `
  SELECT cycle_id, cycle_no, starts_at, ends_at,
         granted_units, carried_units, consumed_units, reserved_units
  FROM cloud_quota_cycle
  WHERE user_id = $1 AND quota_source = 'ALPHA' AND status = 'ACTIVE'`;

function cycleSnapshot(row: CycleRow): QuotaSnapshot {
  const total = Number(row.granted_units) + Number(row.carried_units);
  const used = Number(row.consumed_units);
  const reserved = Number(row.reserved_units);
  const available = Math.max(0, total - used - reserved);
  return {
    source: 'ALPHA',
    total,
    used,
    reserved,
    available,
    remainingRatio: ratio(available, total),
    cycleId: row.cycle_id,
    cycleNo: Number(row.cycle_no),
    cycleStartsAt: row.starts_at,
    cycleEndsAt: row.ends_at
  };
}

export interface OpenCycleInput {
  userId: string;
  batchId: string | null;
  grantId: string | null;
  policy: AlphaQuotaPolicy;
  now?: Date;
  /** Units rolled over from the previous cycle (0 unless the policy carries over). */
  carriedUnits?: number;
}

/**
 * Opens the next Alpha quota cycle. Start/end are written as explicit instants, so no
 * "calendar month" rule is baked into the data. The GRANT ledger row is unique per
 * cycle, which makes the allowance impossible to hand out twice.
 */
export async function openQuotaCycle(
  executor: DbExecutor,
  input: OpenCycleInput
): Promise<{ cycleId: string; cycleNo: number }> {
  const now = input.now ?? new Date();
  const endsAt = new Date(
    now.getTime() + input.policy.cycleDays * 24 * 60 * 60 * 1000
  );

  const existing = await executor.query<CycleRow>(SELECT_ACTIVE_CYCLE, [
    input.userId
  ]);
  if (existing.rows[0]) {
    return {
      cycleId: existing.rows[0].cycle_id,
      cycleNo: Number(existing.rows[0].cycle_no)
    };
  }

  const previous = await executor.query<{ max_no: number | null }>(
    `SELECT MAX(cycle_no) AS max_no FROM cloud_quota_cycle
     WHERE user_id = $1 AND quota_source = 'ALPHA'`,
    [input.userId]
  );
  const cycleNo = Number(previous.rows[0]?.max_no ?? 0) + 1;
  const cycleId = randomUUID();
  const carried = input.policy.carryOver ? Math.max(0, input.carriedUnits ?? 0) : 0;

  await executor.query(
    `INSERT INTO cloud_quota_cycle (
       cycle_id, user_id, quota_source, batch_id, grant_id, cycle_no,
       starts_at, ends_at, granted_units, carried_units
     ) VALUES ($1, $2, 'ALPHA', $3, $4, $5, $6, $7, $8, $9)`,
    [
      cycleId,
      input.userId,
      input.batchId,
      input.grantId,
      cycleNo,
      now.toISOString(),
      endsAt.toISOString(),
      input.policy.cycleUnits,
      carried
    ]
  );
  await executor.query(
    `INSERT INTO cloud_quota_ledger (
       quota_ledger_id, cycle_id, user_id, action_type, units, balance_after
     ) VALUES ($1, $2, $3, 'GRANT', $4, $4)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), cycleId, input.userId, input.policy.cycleUnits + carried]
  );
  return { cycleId, cycleNo };
}

/**
 * Returns the user's current Alpha cycle, rolling to the next one when the current
 * period has ended. Rolling is idempotent: the partial unique index allows only one
 * ACTIVE cycle per user, so a concurrent call reuses the cycle the other opened.
 */
export async function ensureCurrentCycle(
  database: PomChatDatabase,
  userId: string,
  policy: AlphaQuotaPolicy,
  now: Date = new Date()
): Promise<QuotaSnapshot> {
  const current = await database.query<CycleRow>(SELECT_ACTIVE_CYCLE, [userId]);
  const row = current.rows[0];
  if (row && new Date(row.ends_at).getTime() > now.getTime()) {
    return cycleSnapshot(row);
  }

  const membership = await database.query<{
    membership_status: MembershipStatus;
    batch_id: string | null;
  }>(
    `SELECT membership_status, batch_id FROM cloud_membership WHERE user_id = $1`,
    [userId]
  );
  if (membership.rows[0]?.membership_status !== 'ALPHA_ACTIVE') {
    return row ? cycleSnapshot(row) : EMPTY_SNAPSHOT;
  }

  const grant = await database.query<{ grant_id: string }>(
    `SELECT grant_id FROM alpha_grant
     WHERE user_id = $1 AND status = 'GRANTED'`,
    [userId]
  );

  await database.transaction(async (transaction) => {
    if (row) {
      await transaction.query(
        `UPDATE cloud_quota_cycle
         SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
         WHERE cycle_id = $1 AND status = 'ACTIVE'`,
        [row.cycle_id]
      );
    }
    await openQuotaCycle(transaction, {
      userId,
      batchId: membership.rows[0]?.batch_id ?? null,
      grantId: grant.rows[0]?.grant_id ?? null,
      policy,
      now,
      carriedUnits: row
        ? Math.max(
            0,
            Number(row.granted_units) +
              Number(row.carried_units) -
              Number(row.consumed_units) -
              Number(row.reserved_units)
          )
        : 0
    });
  });

  const refreshed = await database.query<CycleRow>(SELECT_ACTIVE_CYCLE, [userId]);
  return refreshed.rows[0] ? cycleSnapshot(refreshed.rows[0]) : EMPTY_SNAPSHOT;
}

export interface QuotaContext {
  userId: string;
  membershipStatus: MembershipStatus;
  policy: AlphaQuotaPolicy;
  trialEnabled: boolean;
}

/**
 * The single place that decides which pool a PLATFORM request draws from. An Alpha
 * user always spends Alpha allowance (never the leftover Trial), a waitlisted user
 * may still finish an unspent Trial, and paused/ended Alpha falls back to nothing.
 */
export async function resolveQuota(
  database: PomChatDatabase,
  context: QuotaContext
): Promise<QuotaSnapshot> {
  if (context.membershipStatus === 'ALPHA_ACTIVE') {
    const cycle = await ensureCurrentCycle(
      database,
      context.userId,
      context.policy
    );
    if (cycle.source === 'ALPHA') return cycle;
  }
  if (context.membershipStatus === 'ALPHA_PAUSED') return EMPTY_SNAPSHOT;

  if (!context.trialEnabled) return EMPTY_SNAPSHOT;
  const trial = await getFreeQuota(database, context.userId);
  if (trial.total === 0) return EMPTY_SNAPSHOT;
  return {
    source: 'TRIAL',
    total: trial.total,
    used: trial.total - trial.remaining,
    reserved: trial.reserved,
    available: trial.available,
    remainingRatio: ratio(trial.available, trial.total),
    cycleId: null,
    cycleNo: null,
    cycleStartsAt: null,
    cycleEndsAt: null
  };
}

export interface ReserveInput extends QuotaContext {
  requestId: string;
  provider: string;
  model: string;
}

export interface Reservation {
  source: QuotaSource;
  acquired: boolean;
  replayed: boolean;
  units: number;
  cycleId: string | null;
  snapshot: QuotaSnapshot;
}

/**
 * One wire code per pool. Alpha exhaustion is its own code because the honest next
 * step differs (wait for the next cycle / BYOK / support), while Trial exhaustion
 * keeps the long-standing `FREE_QUOTA_EXHAUSTED` code that clients already handle —
 * the product meaning is unchanged, only the name in the copy.
 */
function exhausted(source: QuotaSource): AppError {
  return source === 'ALPHA'
    ? new AppError(
        'CLOUD_QUOTA_EXHAUSTED',
        '本期 LiteTavern Cloud Alpha 额度已用完。你可以切换到自己的模型服务继续聊天。',
        429
      )
    : new AppError(
        'FREE_QUOTA_EXHAUSTED',
        'LiteTavern Cloud 试用额度已用完。你可以注册加入 Alpha 候补名单，或切换到自己的模型服务继续聊天。',
        429
      );
}

/**
 * Reserves quota before a model call. Reserving (not deducting) is what keeps
 * concurrent requests from overspending: the reservation is held against the balance
 * and either finalized or released, so a balance can never go negative and a failed
 * request never costs the user anything.
 */
export async function reserveQuota(
  database: PomChatDatabase,
  input: ReserveInput
): Promise<Reservation> {
  const resolved = await resolveQuota(database, input);

  if (resolved.source === 'ALPHA') {
    const units = unitsForRequest(input.policy, input.provider, input.model);
    const cycleId = resolved.cycleId;
    if (!cycleId) throw exhausted('ALPHA');

    let acquired = false;
    let replayed = false;
    await database.transaction(async (transaction) => {
      const prior = await transaction.query<{ quota_ledger_id: string }>(
        `SELECT quota_ledger_id FROM cloud_quota_ledger
         WHERE cycle_id = $1 AND request_id = $2 AND action_type = 'RESERVE'`,
        [cycleId, input.requestId]
      );
      if (prior.rows[0]) {
        replayed = true;
        return;
      }

      if (input.policy.dailyUnitLimit > 0) {
        const spentToday = await transaction.query<{ units: number }>(
          `SELECT COALESCE(SUM(units), 0)::int AS units
           FROM cloud_quota_ledger
           WHERE user_id = $1 AND action_type = 'RESERVE'
             AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 day'`,
          [input.userId]
        );
        if (
          Number(spentToday.rows[0]?.units ?? 0) + units >
          input.policy.dailyUnitLimit
        ) {
          throw new AppError(
            'CLOUD_QUOTA_DAILY_LIMIT',
            '今天的 LiteTavern Cloud 额度已达上限，请明天再试，或切换到自己的模型服务。',
            429,
            true
          );
        }
      }

      const updated = await transaction.query<{ available: number }>(
        `UPDATE cloud_quota_cycle
         SET reserved_units = reserved_units + $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE cycle_id = $1 AND status = 'ACTIVE'
           AND granted_units + carried_units - consumed_units - reserved_units >= $2
         RETURNING granted_units + carried_units - consumed_units - reserved_units
                   AS available`,
        [cycleId, units]
      );
      if (!updated.rows[0]) throw exhausted('ALPHA');

      await transaction.query(
        `INSERT INTO cloud_quota_ledger (
           quota_ledger_id, cycle_id, user_id, request_id, action_type,
           units, balance_after, provider, model
         ) VALUES ($1, $2, $3, $4, 'RESERVE', $5, $6, $7, $8)`,
        [
          randomUUID(),
          cycleId,
          input.userId,
          input.requestId,
          units,
          Number(updated.rows[0].available),
          input.provider,
          input.model
        ]
      );
      acquired = true;
    });

    const snapshot = await ensureCurrentCycle(database, input.userId, input.policy);
    return { source: 'ALPHA', acquired, replayed, units, cycleId, snapshot };
  }

  if (resolved.source === 'TRIAL') {
    const reservation = await reserveFreeQuota(
      database,
      input.userId,
      input.requestId
    );
    const snapshot = await resolveQuota(database, input);
    return {
      source: 'TRIAL',
      acquired: reservation.acquired,
      replayed: reservation.replayed,
      units: 1,
      cycleId: null,
      snapshot
    };
  }

  // Anyone who has been through the Alpha program (active, paused or ended) gets the
  // Alpha-shaped error, so the client shows "this cycle is spent / your access is
  // paused" rather than a Trial message that no longer applies to them.
  throw exhausted(
    input.membershipStatus.startsWith('ALPHA_') ? 'ALPHA' : 'TRIAL'
  );
}

export interface SettleInput extends QuotaContext {
  requestId: string;
  provider: string;
  model: string;
  source: QuotaSource;
  units: number;
  cycleId: string | null;
}

/** Turns a reservation into a deduction. Replaying it is a no-op. */
export async function finalizeQuota(
  database: PomChatDatabase,
  input: SettleInput
): Promise<QuotaSnapshot> {
  if (input.source === 'ALPHA' && input.cycleId) {
    await database.transaction(async (transaction) => {
      const inserted = await transaction.query<{ quota_ledger_id: string }>(
        `INSERT INTO cloud_quota_ledger (
           quota_ledger_id, cycle_id, user_id, request_id, action_type,
           units, balance_after, provider, model
         ) VALUES ($1, $2, $3, $4, 'CONSUME', $5, 0, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING quota_ledger_id`,
        [
          randomUUID(),
          input.cycleId,
          input.userId,
          input.requestId,
          input.units,
          input.provider,
          input.model
        ]
      );
      if (!inserted.rows[0]) return;

      const updated = await transaction.query<{ available: number }>(
        `UPDATE cloud_quota_cycle
         SET reserved_units = reserved_units - $2,
             consumed_units = consumed_units + $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE cycle_id = $1 AND reserved_units >= $2
         RETURNING granted_units + carried_units - consumed_units - reserved_units
                   AS available`,
        [input.cycleId, input.units]
      );
      if (!updated.rows[0]) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          '额度结算状态不一致，请稍后重试。',
          409
        );
      }
      await transaction.query(
        `UPDATE cloud_quota_ledger SET balance_after = $2
         WHERE quota_ledger_id = $1`,
        [inserted.rows[0].quota_ledger_id, Number(updated.rows[0].available)]
      );
    });
    return ensureCurrentCycle(database, input.userId, input.policy);
  }

  if (input.source === 'TRIAL') {
    await finalizeFreeQuota(database, {
      userId: input.userId,
      requestId: input.requestId,
      provider: input.provider,
      model: input.model
    });
  }
  return resolveQuota(database, input);
}

export interface ReleaseInput extends SettleInput {
  failureCode: string;
}

/** Returns a reservation to the balance after a failed request. Idempotent. */
export async function releaseQuota(
  database: PomChatDatabase,
  input: ReleaseInput
): Promise<QuotaSnapshot> {
  if (input.source === 'ALPHA' && input.cycleId) {
    await database.transaction(async (transaction) => {
      const inserted = await transaction.query<{ quota_ledger_id: string }>(
        `INSERT INTO cloud_quota_ledger (
           quota_ledger_id, cycle_id, user_id, request_id, action_type,
           units, balance_after, provider, model, failure_code
         ) VALUES ($1, $2, $3, $4, 'RELEASE', $5, 0, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING quota_ledger_id`,
        [
          randomUUID(),
          input.cycleId,
          input.userId,
          input.requestId,
          input.units,
          input.provider,
          input.model,
          input.failureCode
        ]
      );
      if (!inserted.rows[0]) return;

      const updated = await transaction.query<{ available: number }>(
        `UPDATE cloud_quota_cycle
         SET reserved_units = reserved_units - $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE cycle_id = $1 AND reserved_units >= $2
         RETURNING granted_units + carried_units - consumed_units - reserved_units
                   AS available`,
        [input.cycleId, input.units]
      );
      await transaction.query(
        `UPDATE cloud_quota_ledger SET balance_after = $2
         WHERE quota_ledger_id = $1`,
        [
          inserted.rows[0].quota_ledger_id,
          Number(updated.rows[0]?.available ?? 0)
        ]
      );
    });
    return ensureCurrentCycle(database, input.userId, input.policy);
  }

  if (input.source === 'TRIAL') {
    await releaseFreeQuota(database, {
      userId: input.userId,
      requestId: input.requestId,
      provider: input.provider,
      model: input.model,
      failureCode: input.failureCode
    });
  }
  return resolveQuota(database, input);
}
