import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { recordCloudEvent } from './events.js';

/**
 * Founding Supporter.
 *
 * A voluntary-contribution identity, not a commercial tier. It buys queue priority
 * for the next Alpha batch and a thanks-list entry — deliberately low-cost benefits.
 * It never grants extra model allowance, permanent entitlements, or a bypass of the
 * program's rules, and it is never the only way into Alpha.
 *
 * Marking is done by an operator against a payment reference. There is no payment
 * webhook in this build: the support link is external and confirmation is manual.
 */

export interface MarkSupporterInput {
  userId: string;
  displayName?: string;
  anonymous?: boolean;
  externalReference?: string;
  note?: string;
  markedBy?: string;
}

export async function markFoundingSupporter(
  database: PomChatDatabase,
  input: MarkSupporterInput
): Promise<{ marked: boolean }> {
  const user = await database.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE user_id = $1 AND status = 'ACTIVE'`,
    [input.userId]
  );
  if (!user.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '用户不存在。', 404);

  // Idempotent on the payment reference as well as the user, so re-processing the
  // same contribution never creates a second supporter record.
  const inserted = await database.query<{ user_id: string }>(
    `INSERT INTO founding_supporter (
       user_id, display_name, anonymous, external_reference, marked_by, note
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [
      input.userId,
      input.displayName ?? null,
      input.anonymous ?? true,
      input.externalReference ?? null,
      input.markedBy ?? null,
      input.note ?? null
    ]
  );

  if (inserted.rows[0]) {
    // Mirror the flag onto the membership row so the waitlist ordering and the
    // operator view read one column instead of joining on every query. The
    // founding_supporter table stays the source of truth.
    await database.query(
      `UPDATE cloud_membership
       SET supporter_priority = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [input.userId]
    );
    await recordCloudEvent(database, 'founding_supporter_marked', {
      userId: input.userId,
      properties: { anonymous: input.anonymous ?? true }
    });
  }
  return { marked: inserted.rows.length > 0 };
}

export interface ThanksEntry {
  display_name: string;
  since: string;
}

/** The public thanks list. Supporters are anonymous unless they opted in by name. */
export async function listThanks(
  database: PomChatDatabase,
  limit = 200
): Promise<ThanksEntry[]> {
  const result = await database.query<{ display_name: string; created_at: string }>(
    `SELECT display_name, created_at
     FROM founding_supporter
     WHERE anonymous = FALSE AND display_name IS NOT NULL
     ORDER BY created_at
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.map((row) => ({
    display_name: row.display_name,
    since: row.created_at
  }));
}

export async function countSupporters(
  database: PomChatDatabase
): Promise<number> {
  const result = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM founding_supporter`
  );
  return Number(result.rows[0]?.count ?? 0);
}
