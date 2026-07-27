import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/errors.js';
import type { DbExecutor } from './verification-codes.js';

export type MergeOutcome = 'COMPLETED' | 'ALREADY_MERGED';

// Content tables owned by a user via a single column. Reassigning that column moves
// the row to the target account without touching its primary key or contents, so
// nothing the target already owns is overwritten.
const REASSIGN_BY_USER_ID = [
  ['chat_conversation', 'user_id'],
  ['model_configuration', 'user_id'],
  ['agent_generation_request', 'user_id'],
  ['agent_memory', 'user_id'],
  ['provider_connection', 'user_id'],
  ['analytics_event', 'user_id']
] as const;

/**
 * Merges all anonymous-owned data from `sourceUserId` into `targetUserId` inside the
 * caller's transaction, then marks the source account MERGED. Idempotent: a source
 * already MERGED returns ALREADY_MERGED without re-running. Never overwrites data the
 * target already owns; quota and usage ledgers are deliberately left in place (not
 * summed, not duplicated). Records an auth_account_merge audit row.
 */
export async function mergeUserData(
  transaction: DbExecutor,
  sourceUserId: string,
  targetUserId: string
): Promise<MergeOutcome> {
  if (sourceUserId === targetUserId) {
    throw new AppError('AUTH_MERGE_FAILED', '无法合并同一账号。', 500);
  }

  const source = await transaction.query<{ status: string }>(
    `SELECT status FROM app_user WHERE user_id = $1`,
    [sourceUserId]
  );
  const sourceStatus = source.rows[0]?.status;
  if (!sourceStatus) {
    throw new AppError('AUTH_MERGE_FAILED', '待合并账号不存在。', 500);
  }
  // Already merged (e.g. a retried verify): return the prior result, do not re-run.
  if (sourceStatus === 'MERGED') return 'ALREADY_MERGED';

  const target = await transaction.query<{ status: string }>(
    `SELECT status FROM app_user WHERE user_id = $1 AND status = 'ACTIVE'`,
    [targetUserId]
  );
  if (!target.rows[0]) {
    throw new AppError('AUTH_MERGE_FAILED', '目标账号不可用。', 500);
  }

  // Owned characters (and, transitively, their card versions, conversations,
  // messages, summaries, memories and post-process jobs keyed by those ids).
  await transaction.query(
    `UPDATE agent_character SET owner_user_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE owner_user_id = $1`,
    [sourceUserId, targetUserId]
  );

  for (const [table, column] of REASSIGN_BY_USER_ID) {
    await transaction.query(
      `UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`,
      [sourceUserId, targetUserId]
    );
  }

  // Relationship summary is unique per (user, character). Move only those the target
  // does not already have, so an existing relationship is never overwritten. The
  // conflicting source rows stay attached to the (now MERGED) source for audit.
  await transaction.query(
    `UPDATE agent_relationship AS source
     SET user_id = $2
     WHERE source.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM agent_relationship target
         WHERE target.user_id = $2 AND target.character_id = source.character_id
       )`,
    [sourceUserId, targetUserId]
  );

  await transaction.query(
    `UPDATE app_user
     SET status = 'MERGED', merged_into_user_id = $2,
         deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1`,
    [sourceUserId, targetUserId]
  );

  // Revoke the source's identities so it can never authenticate or spawn new data.
  await transaction.query(
    `UPDATE app_user_identity
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [sourceUserId]
  );

  await transaction.query(
    `INSERT INTO auth_account_merge (
       merge_id, source_user_id, target_user_id, merge_status, completed_at
     ) VALUES ($1, $2, $3, 'COMPLETED', CURRENT_TIMESTAMP)
     ON CONFLICT (source_user_id) DO NOTHING`,
    [randomUUID(), sourceUserId, targetUserId]
  );

  return 'COMPLETED';
}
