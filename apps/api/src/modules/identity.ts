import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../lib/errors.js';
import { getFreeQuota } from './free-quota.js';

export const ANONYMOUS_COOKIE = 'pomchat_anon';

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

const ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function setAnonymousCookie(reply: FastifyReply, token: string) {
  reply.setCookie(ANONYMOUS_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ANON_COOKIE_MAX_AGE
  });
}

/**
 * Rotates the browser session after login/registration/merge: revokes the current
 * anonymous session identity (defence against session fixation) and mints a fresh
 * session token bound to `userId`. Runs inside the caller's transaction so the whole
 * authentication is atomic. Returns the new raw token for the cookie.
 */
export async function rotateSessionIdentity(
  transaction: { query: PomChatDatabase['query'] },
  userId: string,
  previousIdentityId?: string
): Promise<{ token: string; identityId: string }> {
  const token = randomBytes(32).toString('base64url');
  const identityId = randomUUID();
  if (previousIdentityId) {
    await transaction.query(
      `UPDATE app_user_identity
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE identity_id = $1 AND revoked_at IS NULL`,
      [previousIdentityId]
    );
  }
  await transaction.query(
    `INSERT INTO app_user_identity (
       identity_id, user_id, identity_type, subject_hash
     ) VALUES ($1, $2, 'ANONYMOUS', $3)`,
    [identityId, userId, hashToken(token)]
  );
  return { token, identityId };
}

export interface IdentityContext {
  userId: string;
  anonymousId: string;
  email: string | null;
  registered: boolean;
}

export async function resolveIdentityContext(
  request: FastifyRequest,
  database: PomChatDatabase
): Promise<IdentityContext> {
  const token = request.cookies[ANONYMOUS_COOKIE];
  if (!token) throw new AppError('UNAUTHORIZED', '需要匿名身份。', 401);
  const result = await database.query<{
    user_id: string;
    identity_id: string;
    email: string | null;
  }>(
    `SELECT i.user_id, i.identity_id, u.email
     FROM app_user_identity i
     JOIN app_user u ON u.user_id = i.user_id
     WHERE i.identity_type = 'ANONYMOUS'
       AND i.subject_hash = $1
       AND i.revoked_at IS NULL
       AND u.status = 'ACTIVE'`,
    [hashToken(token)]
  );
  const identity = result.rows[0];
  if (!identity) throw new AppError('UNAUTHORIZED', '匿名身份已失效。', 401);
  await database.query(
    `UPDATE app_user_identity
     SET last_seen_at = CURRENT_TIMESTAMP
     WHERE identity_id = $1`,
    [identity.identity_id]
  );
  return {
    userId: identity.user_id,
    anonymousId: identity.identity_id,
    email: identity.email,
    registered: identity.email !== null
  };
}

export async function resolveUserId(
  request: FastifyRequest,
  database: PomChatDatabase
): Promise<string> {
  return (await resolveIdentityContext(request, database)).userId;
}

interface IdentityRouteOptions {
  initialQuota?: number;
  freeQuotaEnabled?: boolean;
  /**
   * Called once, after a brand-new anonymous identity and its one-time LiteTavern
   * Cloud Trial have been committed. Lets the hosted service record the membership
   * and the grant without the core identity module depending on it.
   */
  onAnonymousCreated?: (userId: string, initialQuota: number) => Promise<void>;
}

export async function identityPayload(
  database: PomChatDatabase,
  identity: IdentityContext,
  freeQuotaEnabled: boolean
) {
  const quota = await getFreeQuota(database, identity.userId);
  return {
    user: {
      user_id: identity.userId,
      anonymous_id: identity.anonymousId,
      identity_type: identity.registered ? ('EMAIL' as const) : ('ANONYMOUS' as const),
      email: identity.email,
      registered: identity.registered,
      free_quota_total: quota.total,
      free_quota_remaining: quota.remaining,
      free_quota_available: quota.available,
      free_quota_enabled: freeQuotaEnabled
    }
  };
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  options: IdentityRouteOptions = {}
) {
  const initialQuota = options.initialQuota ?? 30;
  const freeQuotaEnabled = options.freeQuotaEnabled ?? true;

  app.post('/v1/identities/anonymous', async (request, reply) => {
    const existingToken = request.cookies[ANONYMOUS_COOKIE];
    if (existingToken) {
      try {
        const identity = await resolveIdentityContext(request, database);
        return identityPayload(database, identity, freeQuotaEnabled);
      } catch {
        // Replace invalid or revoked tokens with a fresh identity.
      }
    }

    const token = randomBytes(32).toString('base64url');
    const userId = randomUUID();
    const identityId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO app_user (
           user_id, free_quota_total, free_quota_remaining,
           free_quota_reserved, free_quota_granted_at
         ) VALUES ($1, $2, $2, 0, CURRENT_TIMESTAMP)`,
        [userId, initialQuota]
      );
      await transaction.query(
        `INSERT INTO app_user_identity (
           identity_id, user_id, identity_type, subject_hash
         ) VALUES ($1, $2, 'ANONYMOUS', $3)`,
        [identityId, userId, hashToken(token)]
      );
      await transaction.query(
        `INSERT INTO free_quota_ledger (
           quota_ledger_id, user_id, action_type, delta,
           balance_before, balance_after, status
         ) VALUES ($1, $2, 'GRANT', $3, 0, $3, 'GRANTED')`,
        [randomUUID(), userId, initialQuota]
      );
    });

    await options.onAnonymousCreated?.(userId, initialQuota);

    setAnonymousCookie(reply, token);
    return identityPayload(
      database,
      { userId, anonymousId: identityId, email: null, registered: false },
      freeQuotaEnabled
    );
  });

  app.get('/v1/free-quota', async (request) => {
    const identity = await resolveIdentityContext(request, database);
    return identityPayload(database, identity, freeQuotaEnabled);
  });
}

export interface ClaimAuthenticatedIdentityInput {
  anonymousUserId: string;
  identityType: 'ACCOUNT' | 'OAUTH';
  subject: string;
}

/**
 * Called only after an account/OAuth adapter has authenticated `subject`.
 * No public route accepts a raw subject, which prevents a browser from claiming
 * another account by guessing its provider identifier.
 */
export async function claimAuthenticatedIdentity(
  database: PomChatDatabase,
  input: ClaimAuthenticatedIdentityInput
): Promise<{ userId: string; created: boolean }> {
  const subjectHash = hashToken(`${input.identityType}:${input.subject}`);
  let created = false;
  await database.transaction(async (transaction) => {
    const user = await transaction.query<{ user_id: string }>(
      `SELECT user_id FROM app_user
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [input.anonymousUserId]
    );
    if (!user.rows[0]) throw new AppError('UNAUTHORIZED', '匿名用户不存在。', 401);

    const existing = await transaction.query<{ user_id: string }>(
      `SELECT user_id FROM app_user_identity
       WHERE identity_type = $1 AND subject_hash = $2 AND revoked_at IS NULL`,
      [input.identityType, subjectHash]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].user_id !== input.anonymousUserId) {
        throw new AppError(
          'IDENTITY_CONFLICT',
          '该登录身份已属于其他用户，已拒绝关联。',
          409
        );
      }
      return;
    }
    await transaction.query(
      `INSERT INTO app_user_identity (
         identity_id, user_id, identity_type, subject_hash
       ) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), input.anonymousUserId, input.identityType, subjectHash]
    );
    created = true;
  });
  return { userId: input.anonymousUserId, created };
}

export async function requireUser(
  request: FastifyRequest,
  _reply: FastifyReply,
  database: PomChatDatabase
) {
  return resolveUserId(request, database);
}
