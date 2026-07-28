import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { resolveAlphaPolicy, type AlphaQuotaPolicy } from './config.js';
import { openQuotaCycle } from './quota.js';

/**
 * Where a user sits in the LiteTavern Cloud program.
 *
 * Registering a LiteTavern account never grants Alpha on its own: a verified email
 * moves ANONYMOUS_TRIAL → REGISTERED_WAITLIST, and only an explicit release (batch,
 * invite or admin grant) moves REGISTERED_WAITLIST → ALPHA_ACTIVE.
 */
export type MembershipStatus =
  | 'ANONYMOUS_TRIAL'
  | 'REGISTERED_WAITLIST'
  | 'ALPHA_ACTIVE'
  | 'ALPHA_PAUSED'
  | 'ALPHA_ENDED';

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
    activatedAt: row.activated_at
  };
}

const SELECT_MEMBERSHIP = `
  SELECT user_id, membership_status, waitlist_joined_at, waitlist_channel,
         batch_id, grant_source, granted_at, activated_at
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
}

export interface GrantAlphaResult {
  granted: boolean;
  /** Set when the release was rejected rather than replayed. */
  reason?: 'ALREADY_GRANTED' | 'BATCH_FULL' | 'BATCH_NOT_OPEN' | 'NOT_REGISTERED';
  grantId?: string;
  cycleId?: string;
  waitedSeconds?: number;
}

/**
 * Releases one user into an Alpha batch: writes the audit grant, flips membership to
 * ALPHA_ACTIVE and opens the first quota cycle — all in one transaction.
 *
 * Idempotent and concurrency-safe. `idx_alpha_grant_active_user` guarantees a user
 * can hold only one live grant, so two simultaneous releases produce one grant and
 * one ALREADY_GRANTED. Capacity is re-counted inside the transaction, so a batch can
 * never overshoot its cap.
 */
export async function grantAlpha(
  database: PomChatDatabase,
  input: GrantAlphaInput
): Promise<GrantAlphaResult> {
  let result: GrantAlphaResult = { granted: false, reason: 'ALREADY_GRANTED' };

  await database.transaction(async (transaction) => {
    const batch = await transaction.query<{ capacity: number; status: string }>(
      `SELECT capacity, status FROM alpha_batch WHERE batch_id = $1`,
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

    const grantId = randomUUID();
    const inserted = await transaction.query<{ grant_id: string }>(
      `INSERT INTO alpha_grant (
         grant_id, user_id, batch_id, grant_source, status,
         waited_seconds, granted_by
       ) VALUES ($1, $2, $3, $4, 'GRANTED', $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING grant_id`,
      [
        grantId,
        input.userId,
        input.batchId,
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
       VALUES ($1, 'ALPHA_ACTIVE')
       ON CONFLICT (user_id) DO NOTHING`,
      [input.userId]
    );
    await transaction.query(
      `UPDATE cloud_membership
       SET membership_status = 'ALPHA_ACTIVE',
           batch_id = $2, grant_source = $3,
           granted_at = CURRENT_TIMESTAMP,
           activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
           paused_at = NULL, ended_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [input.userId, input.batchId, input.grantSource]
    );

    const cycle = await openQuotaCycle(transaction, {
      userId: input.userId,
      batchId: input.batchId,
      grantId,
      policy: input.policy,
      now
    });

    result = {
      granted: true,
      grantId,
      cycleId: cycle.cycleId,
      ...(waitedSeconds === null ? {} : { waitedSeconds })
    };
  });

  return result;
}

export type MembershipTransition = 'PAUSE' | 'RESUME' | 'END';

/**
 * Suspends, resumes or ends a user's Alpha. Ending revokes the grant so the batch
 * seat is freed and a fresh release is possible later. Already-granted cycles are
 * left in place: a paused user simply cannot spend them.
 */
export async function transitionAlpha(
  database: PomChatDatabase,
  userId: string,
  transition: MembershipTransition,
  reason?: string
): Promise<Membership> {
  await database.transaction(async (transaction) => {
    if (transition === 'PAUSE') {
      await transaction.query(
        `UPDATE cloud_membership
         SET membership_status = 'ALPHA_PAUSED',
             paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND membership_status = 'ALPHA_ACTIVE'`,
        [userId]
      );
    } else if (transition === 'RESUME') {
      await transaction.query(
        `UPDATE cloud_membership
         SET membership_status = 'ALPHA_ACTIVE',
             paused_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND membership_status = 'ALPHA_PAUSED'`,
        [userId]
      );
    } else {
      await transaction.query(
        `UPDATE cloud_membership
         SET membership_status = 'ALPHA_ENDED',
             ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND membership_status IN ('ALPHA_ACTIVE', 'ALPHA_PAUSED')`,
        [userId]
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
}

/**
 * Waitlist ordering. Founding Supporters are placed ahead of the general queue — a
 * priority, not a guarantee, and never the only way in: `DIRECT_INVITE` and
 * `ADMIN_GRANT` releases bypass this ordering entirely. Within each tier the order is
 * "waiting longest first"; an operator can still pick individual users explicitly.
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
  return result.rows.map((row) => ({
    userId: row.user_id,
    joinedAt: row.waitlist_joined_at,
    channel: row.waitlist_channel,
    foundingSupporter: row.founding_supporter
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
