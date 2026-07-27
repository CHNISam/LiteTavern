import { randomUUID } from 'node:crypto';
import { normalizeEmail } from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import {
  hashToken,
  rotateSessionIdentity,
  type IdentityContext
} from '../identity.js';
import { consumeVerificationCode } from './verification-codes.js';
import { mergeUserData } from './account-merge.js';

export type AuthOutcome = 'REGISTERED' | 'LOGGED_IN' | 'MERGED';

export interface AuthResult {
  outcome: AuthOutcome;
  /** Fresh session token to write to the anonymous cookie. */
  token: string;
  context: IdentityContext;
}

function emailSubjectHash(email: string): string {
  return hashToken(`EMAIL:${email}`);
}

/**
 * Completes an email-code sign-in. In one transaction it consumes the code and then,
 * based on whether the email is already bound:
 *  - unbound  → upgrades the current anonymous user in place (user_id preserved),
 *  - bound to the current user → logs in unchanged,
 *  - bound to another account → logs into it, merging the anonymous data.
 * Finally it rotates the session token (fixation defence) and returns the new
 * identity context. The whole operation is atomic and idempotent under retries.
 */
export async function authenticateWithEmail(
  database: PomChatDatabase,
  session: IdentityContext,
  emailInput: string,
  code: string
): Promise<AuthResult> {
  const email = normalizeEmail(emailInput);
  let outcome: AuthOutcome = 'LOGGED_IN';
  let targetUserId = session.userId;
  let token = '';
  let newIdentityId = '';

  // Verify and consume the code in its own committed step. Attempt-count increments
  // and single-use consumption must survive even when the code is wrong (otherwise a
  // rolled-back auth transaction would reset the attempt counter and defeat the cap).
  await consumeVerificationCode(database, email, code);

  await database.transaction(async (transaction) => {
    const existing = await transaction.query<{ user_id: string }>(
      `SELECT user_id FROM app_user_identity
       WHERE identity_type = 'EMAIL' AND subject_hash = $1 AND revoked_at IS NULL`,
      [emailSubjectHash(email)]
    );
    const boundUserId = existing.rows[0]?.user_id;

    if (!boundUserId) {
      // In-place upgrade: same user_id, add EMAIL identity, mark registered.
      await transaction.query(
        `INSERT INTO app_user_identity (
           identity_id, user_id, identity_type, subject_hash, email_normalized
         ) VALUES ($1, $2, 'EMAIL', $3, $4)`,
        [randomUUID(), session.userId, emailSubjectHash(email), email]
      );
      await transaction.query(
        `UPDATE app_user SET email = $2, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [session.userId, email]
      );
      outcome = 'REGISTERED';
      targetUserId = session.userId;
    } else if (boundUserId === session.userId) {
      outcome = 'LOGGED_IN';
      targetUserId = session.userId;
    } else {
      targetUserId = boundUserId;
      // Only merge an anonymous session into the target. A session that is already
      // registered is a deliberate account switch — log in without merging so a full
      // account's data is never silently folded into another.
      if (!session.registered) {
        const merge = await mergeUserData(transaction, session.userId, boundUserId);
        outcome = merge === 'COMPLETED' ? 'MERGED' : 'LOGGED_IN';
      } else {
        outcome = 'LOGGED_IN';
      }
    }

    const rotated = await rotateSessionIdentity(
      transaction,
      targetUserId,
      session.anonymousId
    );
    token = rotated.token;
    newIdentityId = rotated.identityId;
  });

  const emailRow = await database.query<{ email: string | null }>(
    `SELECT email FROM app_user WHERE user_id = $1`,
    [targetUserId]
  );
  const targetEmail = emailRow.rows[0]?.email ?? null;

  return {
    outcome,
    token,
    context: {
      userId: targetUserId,
      anonymousId: newIdentityId,
      email: targetEmail,
      registered: targetEmail !== null
    }
  };
}
