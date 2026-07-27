import { createHash, randomInt, randomUUID } from 'node:crypto';
import { normalizeEmail } from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import type { EmailProvider } from './email-provider.js';

// Any object exposing `query` — the database itself or a transaction handle.
export interface DbExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

export const CODE_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_ATTEMPTS = 5;
const EMAIL_HOURLY_SEND_LIMIT = 5;
const IP_HOURLY_SEND_LIMIT = 20;

function hashCode(email: string, code: string): string {
  // Bind the hash to the email so a leaked hash cannot be replayed for another
  // address, and so codes are never comparable across emails.
  return createHash('sha256').update(`${email}:${code}`).digest('hex');
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface SendCodeInput {
  email: string;
  ip?: string | undefined;
  sessionIdentityId?: string | undefined;
}

/**
 * Generates, stores (hashed) and sends a fresh code. Enforces resend cooldown and
 * per-email / per-IP hourly limits. Issuing a new code invalidates any previous
 * unconsumed one for the same email. Throws AppError('CODE_SEND_RATE_LIMITED') when
 * limited; never reveals whether the email already has an account.
 */
export async function sendVerificationCode(
  database: PomChatDatabase,
  provider: EmailProvider,
  input: SendCodeInput
): Promise<void> {
  const email = normalizeEmail(input.email);

  const cooldown = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM auth_email_verification_code
     WHERE email_normalized = $1
       AND created_at > CURRENT_TIMESTAMP - ($2 || ' seconds')::interval`,
    [email, String(RESEND_COOLDOWN_SECONDS)]
  );
  if ((cooldown.rows[0]?.count ?? 0) > 0) {
    throw new AppError(
      'CODE_SEND_RATE_LIMITED',
      '发送过于频繁，请稍后再试。',
      429,
      true
    );
  }

  const emailHour = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM auth_email_verification_code
     WHERE email_normalized = $1
       AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
    [email]
  );
  if ((emailHour.rows[0]?.count ?? 0) >= EMAIL_HOURLY_SEND_LIMIT) {
    throw new AppError('CODE_SEND_RATE_LIMITED', '请求次数过多，请稍后再试。', 429, true);
  }

  if (input.ip) {
    const ipHour = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM auth_email_verification_code
       WHERE request_ip = $1
         AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
      [input.ip]
    );
    if ((ipHour.rows[0]?.count ?? 0) >= IP_HOURLY_SEND_LIMIT) {
      throw new AppError('CODE_SEND_RATE_LIMITED', '请求次数过多，请稍后再试。', 429, true);
    }
  }

  const code = generateCode();
  await database.transaction(async (transaction) => {
    // A new code supersedes any earlier active one (single active code per email,
    // enforced by idx_email_code_active).
    await transaction.query(
      `UPDATE auth_email_verification_code
       SET consumed_at = CURRENT_TIMESTAMP
       WHERE email_normalized = $1 AND consumed_at IS NULL`,
      [email]
    );
    await transaction.query(
      `INSERT INTO auth_email_verification_code (
         code_id, email_normalized, code_hash, purpose,
         session_identity_id, request_ip, expires_at, max_attempts
       ) VALUES (
         $1, $2, $3, 'LOGIN', $4, $5,
         CURRENT_TIMESTAMP + ($6 || ' minutes')::interval, $7
       )`,
      [
        randomUUID(),
        email,
        hashCode(email, code),
        input.sessionIdentityId ?? null,
        input.ip ?? null,
        String(CODE_TTL_MINUTES),
        MAX_ATTEMPTS
      ]
    );
  });

  await provider.sendVerificationCode({
    to: email,
    code,
    expiresInMinutes: CODE_TTL_MINUTES
  });
}

interface CodeRow {
  code_id: string;
  code_hash: string;
  attempt_count: number;
  max_attempts: number;
  expired: boolean;
}

/**
 * Verifies a code inside an existing transaction and consumes it on success. All
 * failure modes are distinguished by error code but none reveal account existence.
 * Marks the code consumed on success, expiry, or once the attempt cap is reached so
 * a code can never be reused or brute-forced.
 */
export async function consumeVerificationCode(
  transaction: DbExecutor,
  emailInput: string,
  code: string
): Promise<void> {
  const email = normalizeEmail(emailInput);
  const result = await transaction.query<CodeRow>(
    `SELECT code_id, code_hash, attempt_count, max_attempts,
            (expires_at <= CURRENT_TIMESTAMP) AS expired
     FROM auth_email_verification_code
     WHERE email_normalized = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [email]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('CODE_INVALID', '验证码不正确或已失效。', 400);
  }

  if (row.expired) {
    await transaction.query(
      `UPDATE auth_email_verification_code
       SET consumed_at = CURRENT_TIMESTAMP
       WHERE code_id = $1`,
      [row.code_id]
    );
    throw new AppError('CODE_EXPIRED', '验证码已过期，请重新获取。', 400);
  }

  if (row.code_hash !== hashCode(email, code)) {
    const attempts = Number(row.attempt_count) + 1;
    const exhausted = attempts >= Number(row.max_attempts);
    await transaction.query(
      `UPDATE auth_email_verification_code
       SET attempt_count = $2,
           consumed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE consumed_at END
       WHERE code_id = $1`,
      [row.code_id, attempts, exhausted]
    );
    if (exhausted) {
      throw new AppError(
        'CODE_ATTEMPTS_EXCEEDED',
        '尝试次数过多，请重新获取验证码。',
        429
      );
    }
    throw new AppError('CODE_INVALID', '验证码不正确或已失效。', 400);
  }

  // Single-use: consuming here means a concurrent verify sees no active row.
  await transaction.query(
    `UPDATE auth_email_verification_code
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE code_id = $1`,
    [row.code_id]
  );
}
