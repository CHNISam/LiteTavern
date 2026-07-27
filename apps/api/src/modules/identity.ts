import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../lib/errors.js';

export const ANONYMOUS_COOKIE = 'pomchat_anon';

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function resolveUserId(
  request: FastifyRequest,
  database: PomChatDatabase
): Promise<string> {
  const token = request.cookies[ANONYMOUS_COOKIE];
  if (!token) throw new AppError('UNAUTHORIZED', '需要匿名身份。', 401);
  const result = await database.query<{ user_id: string }>(
    `SELECT i.user_id
     FROM app_user_identity i
     JOIN app_user u ON u.user_id = i.user_id
     WHERE i.identity_type = 'ANONYMOUS'
       AND i.subject_hash = $1
       AND i.revoked_at IS NULL
       AND u.status = 'ACTIVE'`,
    [hashToken(token)]
  );
  const userId = result.rows[0]?.user_id;
  if (!userId) throw new AppError('UNAUTHORIZED', '匿名身份已失效。', 401);
  return userId;
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  options: { platformAvailable: boolean }
) {
  const capabilities = { platform_available: options.platformAvailable };
  app.post('/v1/identities/anonymous', async (request, reply) => {
    const existingToken = request.cookies[ANONYMOUS_COOKIE];
    if (existingToken) {
      try {
        const userId = await resolveUserId(request, database);
        return { user: { user_id: userId, identity_type: 'ANONYMOUS' }, capabilities };
      } catch {
        // Replace invalid or revoked tokens with a fresh identity.
      }
    }

    const token = randomBytes(32).toString('base64url');
    const userId = randomUUID();
    await database.exec('BEGIN');
    try {
      await database.query(`INSERT INTO app_user (user_id) VALUES ($1)`, [userId]);
      await database.query(
        `INSERT INTO app_user_identity
         (identity_id, user_id, identity_type, subject_hash)
         VALUES ($1, $2, 'ANONYMOUS', $3)`,
        [randomUUID(), userId, hashToken(token)]
      );
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }

    reply.setCookie(ANONYMOUS_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365
    });
    return { user: { user_id: userId, identity_type: 'ANONYMOUS' }, capabilities };
  });
}

export async function requireUser(
  request: FastifyRequest,
  _reply: FastifyReply,
  database: PomChatDatabase
) {
  return resolveUserId(request, database);
}
