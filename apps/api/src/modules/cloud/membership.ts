import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { resolveAlphaPolicy, type AlphaQuotaPolicy } from './config.js';
import { lockPlanForUpdate, recordCapacityAudit } from './plan.js';
import { openQuotaCycle } from './quota.js';

/**
 * Where a user sits in the LiteTavern Cloud program.
 *
 * Registering a LiteTavern account never grants Alpha on its own: a verified email
 * moves ANONYMOUS_TRIAL → REGISTERED_WAITLIST, and only an explicit release (batch,
 * invite or admin grant) moves REGISTERED_WAITLIST → ALPHA_GRANTED.
 *
 * Holding a seat and using it are separate states on purpose. ALPHA_GRANTED means a
 * seat is reserved and consuming released capacity; ALPHA_ACTIVE means the user has
 * actually entered and their quota cycle is running. Collapsing the two would make
 * "10 seats issued, 3 people testing" unrepresentable — which is precisely the
 * situation the effective-tester gate and the reclaim path exist to handle.
 */
export type MembershipStatus =
  | 'ANONYMOUS_TRIAL'
  | 'REGISTERED_WAITLIST'
  | 'ALPHA_GRANTED'
  | 'ALPHA_ACTIVE'
  | 'ALPHA_PAUSED'
  | 'ALPHA_ENDED';

/** Statuses that hold a seat against the plan's released capacity. */
export const SEAT_HOLDING_STATUSES: readonly MembershipStatus[] = [
  'ALPHA_GRANTED',
  'ALPHA_ACTIVE',
  'ALPHA_PAUSED'
];

/** Statuses allowed to reach Alpha-only capabilities. */
export function hasAlphaAccess(status: MembershipStatus): boolean {
  return status === 'ALPHA_ACTIVE';
}

export type GrantSource =
  | 'SUPPORTER_PRIORITY'
  | 'WAITLIST'
  | 'DIRECT_INVITE'
  | 'ADMIN_GRANT';

export const GRANT_SOURCES: readonly GrantSource[] = [
  'SUPPORTER_PRIORITY',
  'WAITLIST',
  'DIRECT_INVITE',
  'ADMIN_GRANT'
];

export interface Membership {
  userId: string;
  status: MembershipStatus;
  waitlistJoinedAt: string | null;
  waitlistChannel: string | null;
  batchId: string | null;
  grantSource: GrantSource | null;
  grantedAt: string | null;
  activatedAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  revokedReason: string | null;
  supporterPriority: boolean;
}

interface MembershipRow {
  user_id: string;
  membership_status: MembershipStatus;
  waitlist_joined_at: string | null;
  waitlist_channel: string | null;
  batch_id: string | null;
  grant_source: GrantSource | null;
  granted_at: string | null;
  activated_at: string | null;
  paused_at: string | null;
  ended_at: string | null;
  revoked_reason: string | null;
  supporter_priority: boolean;
}

function toMembership(row: MembershipRow): Membership {
  return {
    userId: row.user_id,
    status: row.membership_status,
    waitlistJoinedAt: row.waitlist_joined_at,
    waitlistChannel: row.waitlist_channel,
    batchId: row.batch_id,
    grantSource: row.grant_source,
    grantedAt: row.granted_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
    endedAt: row.ended_at,
    revokedReason: row.revoked_reason,
    supporterPriority: row.supporter_priority
  };
}

const SELECT_MEMBERSHIP = `
  SELECT user_id, membership_status, waitlist_joined_at, waitlist_channel,
         batch_id, grant_source, granted_at, activated_at, paused_at, ended_at,
         revoked_reason, supporter_priority
  FROM cloud_membership
  WHERE user_id = $1`;

/**
 * Reads the membership row, creating the initial one on first sight. Idempotent and
 * safe to call on every request: an existing row is never downgraded.
 */
export async function ensureMembership(
  database: PomChatDatabase,
  userId: string,
  registered: boolean
): Promise<Membership> {
  const existing = await database.query<MembershipRow>(SELECT_MEMBERSHIP, [userId]);
  if (existing.rows[0]) return toMembership(existing.rows[0]);

  await database.query(
    `INSERT INTO cloud_membership (
       user_id, membership_status, waitlist_joined_at
     ) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [
      userId,
      registered ? 'REGISTERED_WAITLIST' : 'ANONYMOUS_TRIAL',
      registered ? new Date().toISOString() : null
    ]
  );
  const created = await database.query<MembershipRow>(SELECT_MEMBERSHIP, [userId]);
  const row = created.rows[0];
  if (!row) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);
  return toMembership(row);
}

/**
 * Puts a registered user into the Alpha waitlist. Idempotent — repeating it keeps the
 * original `waitlist_joined_at` so queue position is never reset — and it never
 * touches a user who already holds (or held) Alpha.
 */
export async function joinWaitlist(
  database: PomChatDatabase,
  userId: string,
  channel?: string
): Promise<{ joined: boolean; membership: Membership }> {
  const registered = await database.query<{ email: string | null }>(
    `SELECT email FROM app_user WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId]
  );
  if (!registered.rows[0]) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);
  if (!registered.rows[0].email) {
    throw new AppError(
      'REGISTRATION_REQUIRED',
      '请先完成邮箱验证，再加入 LiteTavern Cloud Alpha 候补名单。',
      403
    );
  }

  await ensureMembership(database, userId, true);
  const updated = await database.query<{ user_id: string }>(
    `UPDATE cloud_membership
     SET membership_status = 'REGISTERED_WAITLIST',
         waitlist_joined_at = COALESCE(waitlist_joined_at, CURRENT_TIMESTAMP),
         waitlist_channel = COALESCE(waitlist_channel, $2),
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND membership_status = 'ANONYMOUS_TRIAL'
     RETURNING user_id`,
    [userId, channel ?? null]
  );

  const current = await database.query<MembershipRow>(SELECT_MEMBERSHIP, [userId]);
  const row = current.rows[0];
  if (!row) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);
  return { joined: updated.rows.length > 0, membership: toMembership(row) };
}

/**
 * Called right after a successful email verification. A brand-new registration lands
 * on the waitlist; an account that already holds Alpha keeps it untouched.
 */
export async function onRegistrationCompleted(
  database: PomChatDatabase,
  userId: string
): Promise<Membership> {
  await ensureMembership(database, userId, true);
  await database.query(
    `UPDATE cloud_membership
     SET membership_status = 'REGISTERED_WAITLIST',
         waitlist_joined_at = COALESCE(waitlist_joined_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND membership_status = 'ANONYMOUS_TRIAL'`,
    [userId]
  );
  const current = await database.query<MembershipRow>(SELECT_MEMBERSHIP, [userId]);
  const row = current.rows[0];
  if (!row) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);
  return toMembership(row);
}

export interface GrantAlphaInput {
  userId: string;
  batchId: string;
  grantSource: GrantSource;
  grantedBy?: string;
  policy: AlphaQuotaPolicy;
  now?: Date;
  planKey?: string;
}

export interface GrantAlphaResult {
  granted: boolean;
  /** Set when the release was rejected rather than replayed. */
  reason?:
    | 'ALREADY_GRANTED'
    | 'BATCH_FULL'
    | 'BATCH_NOT_OPEN'
    | 'NOT_REGISTERED'
    | 'PROGRAM_CAPACITY_EXHAUSTED'
    | 'PLAN_PAUSED';
  grantId?: string;
  batchNo?: number;
  waitedSeconds?: number;
}

/**
 * Releases one user into an Alpha batch: writes the audit grant and moves membership
 * to ALPHA_GRANTED, in one transaction. The quota cycle is deliberately *not* opened
 * here — it starts when the user actually enters, in `activateAlpha`, so an unused
 * seat never silently burns a cycle.
 *
 * Overshoot is prevented at two independent levels:
 *
 *  1. `lockPlanForUpdate` takes a row lock on the single plan row, then live grants
 *     are re-counted inside the same transaction and checked against
 *     `released_capacity`. Because every grant serialises behind that one lock, two
 *     concurrent releases cannot both observe the same free seat.
 *  2. `idx_alpha_grant_active_user` (a partial unique index on GRANTED rows)
 *     guarantees a user holds at most one live grant, so a duplicate release is a
 *     no-op rather than a second seat.
 *
 * Per-batch capacity is still enforced on top of the program ceiling, so a wave-1
 * batch of 10 stays a batch of 10 even after the program ceiling rises to 30.
 */
export async function grantAlpha(
  database: PomChatDatabase,
  input: GrantAlphaInput
): Promise<GrantAlphaResult> {
  let result: GrantAlphaResult = { granted: false, reason: 'ALREADY_GRANTED' };

  await database.transaction(async (transaction) => {
    // Serialises every seat-consuming operation in the program.
    const plan = await lockPlanForUpdate(transaction, input.planKey);
    if (plan.paused) {
      result = { granted: false, reason: 'PLAN_PAUSED' };
      return;
    }

    const batch = await transaction.query<{
      capacity: number;
      status: string;
      batch_no: number | null;
    }>(
      `SELECT capacity, status, batch_no FROM alpha_batch WHERE batch_id = $1`,
      [input.batchId]
    );
    const batchRow = batch.rows[0];
    if (!batchRow) throw new AppError('RESOURCE_NOT_FOUND', '批次不存在。', 404);
    if (batchRow.status !== 'OPEN') {
      result = { granted: false, reason: 'BATCH_NOT_OPEN' };
      return;
    }

    const user = await transaction.query<{ email: string | null }>(
      `SELECT email FROM app_user WHERE user_id = $1 AND status = 'ACTIVE'`,
      [input.userId]
    );
    if (!user.rows[0]?.email) {
      result = { granted: false, reason: 'NOT_REGISTERED' };
      return;
    }

    // Program ceiling: live grants across every batch versus released capacity.
    const live = await transaction.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM alpha_grant WHERE status = 'GRANTED'`
    );
    if (Number(live.rows[0]?.count ?? 0) >= plan.released_capacity) {
      result = { granted: false, reason: 'PROGRAM_CAPACITY_EXHAUSTED' };
      return;
    }

    const used = await transaction.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM alpha_grant
       WHERE batch_id = $1 AND status = 'GRANTED'`,
      [input.batchId]
    );
    if (Number(used.rows[0]?.count ?? 0) >= Number(batchRow.capacity)) {
      result = { granted: false, reason: 'BATCH_FULL' };
      return;
    }

    const membership = await transaction.query<MembershipRow>(SELECT_MEMBERSHIP, [
      input.userId
    ]);
    const waitlistJoinedAt = membership.rows[0]?.waitlist_joined_at ?? null;
    const now = input.now ?? new Date();
    const waitedSeconds = waitlistJoinedAt
      ? Math.max(
          0,
          Math.round((now.getTime() - new Date(waitlistJoinedAt).getTime()) / 1000)
        )
      : null;

    const batchNo = Number(batchRow.batch_no ?? plan.current_batch_no);
    const grantId = randomUUID();
    const inserted = await transaction.query<{ grant_id: string }>(
      `INSERT INTO alpha_grant (
         grant_id, user_id, batch_id, batch_no, grant_source, status,
         waited_seconds, granted_by
       ) VALUES ($1, $2, $3, $4, $5, 'GRANTED', $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING grant_id`,
      [
        grantId,
        input.userId,
        input.batchId,
        batchNo,
        input.grantSource,
        waitedSeconds,
        input.grantedBy ?? null
      ]
    );
    if (!inserted.rows[0]) {
      result = { granted: false, reason: 'ALREADY_GRANTED' };
      return;
    }

    await transaction.query(
      `INSERT INTO cloud_membership (user_id, membership_status)
       VALUES ($1, 'ALPHA_GRANTED')
       ON CONFLICT (user_id) DO NOTHING`,
      [input.userId]
    );
    await transaction.query(
      `UPDATE cloud_membership
       SET membership_status = 'ALPHA_GRANTED',
           batch_id = $2, grant_source = $3,
           granted_at = CURRENT_TIMESTAMP,
           paused_at = NULL, ended_at = NULL, revoked_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [input.userId, input.batchId, input.grantSource]
    );

    await recordCapacityAudit(transaction, {
      ...(input.planKey ? { planKey: input.planKey } : {}),
      action: 'GRANT',
      actor: input.grantedBy ?? 'system',
      userId: input.userId,
      batchNo,
      detail: {
        grant_id: grantId,
        batch_id: input.batchId,
        grant_source: input.grantSource,
        released_capacity: plan.released_capacity,
        seats_used_before: Number(live.rows[0]?.count ?? 0)
      }
    });

    result = {
      granted: true,
      grantId,
      batchNo,
      ...(waitedSeconds === null ? {} : { waitedSeconds })
    };
  });

  return result;
}

export interface ActivateAlphaResult {
  activated: boolean;
  /** True when the user had already entered; the original timestamp is kept. */
  alreadyActive: boolean;
  membership: Membership;
  cycleId?: string;
}

/**
 * The user's own "enter Alpha" step: ALPHA_GRANTED → ALPHA_ACTIVE, opening the first
 * quota cycle. Idempotent — a repeat call keeps the original `activated_at` and does
 * not open a second cycle — and it refuses any status other than ALPHA_GRANTED, so a
 * suspended or revoked user cannot re-enter by replaying the request.
 */
export async function activateAlpha(
  database: PomChatDatabase,
  input: { userId: string; policy: AlphaQuotaPolicy; now?: Date }
): Promise<ActivateAlphaResult> {
  let activated = false;
  let alreadyActive = false;
  let cycleId: string | undefined;

  await database.transaction(async (transaction) => {
    const current = await transaction.query<MembershipRow>(
      `${SELECT_MEMBERSHIP} FOR UPDATE`,
      [input.userId]
    );
    const row = current.rows[0];
    if (!row) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);

    if (row.membership_status === 'ALPHA_ACTIVE') {
      alreadyActive = true;
      return;
    }
    if (row.membership_status !== 'ALPHA_GRANTED') {
      throw new AppError(
        'ALPHA_NOT_GRANTED',
        '你还没有获得 LiteTavern Cloud Alpha 资格。',
        403
      );
    }

    const grant = await transaction.query<{ grant_id: string }>(
      `SELECT grant_id FROM alpha_grant
       WHERE user_id = $1 AND status = 'GRANTED'`,
      [input.userId]
    );
    if (!grant.rows[0]) {
      throw new AppError(
        'ALPHA_NOT_GRANTED',
        '你的 Alpha 资格已失效，请联系我们。',
        403
      );
    }

    await transaction.query(
      `UPDATE cloud_membership
       SET membership_status = 'ALPHA_ACTIVE',
           activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [input.userId]
    );

    const cycle = await openQuotaCycle(transaction, {
      userId: input.userId,
      batchId: row.batch_id,
      grantId: grant.rows[0].grant_id,
      policy: input.policy,
      now: input.now ?? new Date()
    });
    cycleId = cycle.cycleId;
    activated = true;

    await recordCapacityAudit(transaction, {
      action: 'ACTIVATE',
      actor: input.userId,
      userId: input.userId,
      detail: { batch_id: row.batch_id, cycle_id: cycle.cycleId }
    });
  });

  const refreshed = await database.query<MembershipRow>(SELECT_MEMBERSHIP, [
    input.userId
  ]);
  const row = refreshed.rows[0];
  if (!row) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);

  return {
    activated,
    alreadyActive,
    membership: toMembership(row),
    ...(cycleId ? { cycleId } : {})
  };
}

export type MembershipTransition = 'PAUSE' | 'RESUME' | 'END';

/**
 * Suspends, resumes or ends a user's Alpha. Ending revokes the grant so the seat is
 * freed against the plan's released capacity and can be re-issued. Already-granted
 * cycles are left in place: a paused user simply cannot spend them, because
 * `resolveQuota` returns nothing for any status other than ALPHA_ACTIVE.
 *
 * A suspension takes effect on the next request with no cache to invalidate — the
 * membership row is the authority and every platform call reads it.
 */
export async function transitionAlpha(
  database: PomChatDatabase,
  userId: string,
  transition: MembershipTransition,
  reason?: string,
  actor = 'admin'
): Promise<Membership> {
  await database.transaction(async (transaction) => {
    if (transition === 'PAUSE') {
      // A seat that has not been entered yet can be suspended too.
      await transaction.query(
        `UPDATE cloud_membership
         SET membership_status = 'ALPHA_PAUSED',
             paused_at = CURRENT_TIMESTAMP,
             revoked_reason = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND membership_status IN ('ALPHA_GRANTED', 'ALPHA_ACTIVE')`,
        [userId, reason ?? null]
      );
    } else if (transition === 'RESUME') {
      // Resuming returns the user to whichever side of the line they were on:
      // someone who never entered goes back to ALPHA_GRANTED, not ALPHA_ACTIVE.
      await transaction.query(
        `UPDATE cloud_membership
         SET membership_status =
               CASE WHEN activated_at IS NULL THEN 'ALPHA_GRANTED'
                    ELSE 'ALPHA_ACTIVE' END,
             paused_at = NULL, revoked_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND membership_status = 'ALPHA_PAUSED'`,
        [userId]
      );
    } else {
      await transaction.query(
        `UPDATE cloud_membership
         SET membership_status = 'ALPHA_ENDED',
             ended_at = CURRENT_TIMESTAMP,
             revoked_reason = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND membership_status IN ('ALPHA_GRANTED', 'ALPHA_ACTIVE', 'ALPHA_PAUSED')`,
        [userId, reason ?? null]
      );
      await transaction.query(
        `UPDATE alpha_grant
         SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP,
             revoked_reason = $2
         WHERE user_id = $1 AND status = 'GRANTED'`,
        [userId, reason ?? null]
      );
      await transaction.query(
        `UPDATE cloud_quota_cycle
         SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND status = 'ACTIVE'`,
        [userId]
      );
    }

    await recordCapacityAudit(transaction, {
      action:
        transition === 'PAUSE'
          ? 'SUSPEND'
          : transition === 'RESUME'
            ? 'RESUME'
            : 'REVOKE',
      actor,
      userId,
      reason: reason ?? null
    });
  });

  const current = await database.query<MembershipRow>(SELECT_MEMBERSHIP, [userId]);
  const row = current.rows[0];
  if (!row) throw new AppError('RESOURCE_NOT_FOUND', '用户不存在。', 404);
  return toMembership(row);
}

export interface WaitlistCandidate {
  userId: string;
  joinedAt: string | null;
  channel: string | null;
  foundingSupporter: boolean;
  /** 1-based position under the system ordering, for the operator view only. */
  rank: number;
}

/**
 * Waitlist ordering, computed in SQL so it is the same for every caller and cannot be
 * re-ordered by a client.
 *
 * Three rules, in order: eligibility (registered, active, actually waitlisted),
 * Founding Supporter priority, then longest-waiting first with `user_id` as a stable
 * tie-break. Supporter status only reorders the queue — it is never the sole route in
 * and grants no extra allowance, and `DIRECT_INVITE` / `ADMIN_GRANT` releases bypass
 * the ordering entirely while still being audited.
 *
 * The rank is returned to operators only. It is deliberately not shown to waiting
 * users: it moves as people join, leave and are released, so presenting it as a
 * position would be a promise the program cannot keep.
 */
export async function listWaitlist(
  database: PomChatDatabase,
  limit = 100
): Promise<WaitlistCandidate[]> {
  const result = await database.query<{
    user_id: string;
    waitlist_joined_at: string | null;
    waitlist_channel: string | null;
    founding_supporter: boolean;
  }>(
    `SELECT m.user_id, m.waitlist_joined_at, m.waitlist_channel,
            (s.user_id IS NOT NULL) AS founding_supporter
     FROM cloud_membership m
     LEFT JOIN founding_supporter s ON s.user_id = m.user_id
     JOIN app_user u ON u.user_id = m.user_id AND u.status = 'ACTIVE'
     WHERE m.membership_status = 'REGISTERED_WAITLIST'
     ORDER BY (s.user_id IS NOT NULL) DESC,
              m.waitlist_joined_at ASC NULLS LAST,
              m.user_id
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.map((row, index) => ({
    userId: row.user_id,
    joinedAt: row.waitlist_joined_at,
    channel: row.waitlist_channel,
    foundingSupporter: row.founding_supporter,
    rank: index + 1
  }));
}

export async function isFoundingSupporter(
  database: PomChatDatabase,
  userId: string
): Promise<boolean> {
  const result = await database.query<{ user_id: string }>(
    `SELECT user_id FROM founding_supporter WHERE user_id = $1`,
    [userId]
  );
  return result.rows.length > 0;
}

/** Reads a batch's quota policy, falling back to the deployment default. */
export async function readBatchPolicy(
  database: PomChatDatabase,
  batchId: string,
  fallback: AlphaQuotaPolicy
): Promise<AlphaQuotaPolicy> {
  const result = await database.query<{ quota_policy_json: unknown }>(
    `SELECT quota_policy_json FROM alpha_batch WHERE batch_id = $1`,
    [batchId]
  );
  return resolveAlphaPolicy(fallback, result.rows[0]?.quota_policy_json);
}
