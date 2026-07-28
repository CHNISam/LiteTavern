import type { FastifyInstance } from 'fastify';
import { emailCodeSendSchema, emailCodeVerifySchema } from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import {
  ANONYMOUS_COOKIE,
  hashToken,
  identityPayload,
  resolveIdentityContext,
  setAnonymousCookie
} from '../identity.js';
import type { EmailProvider } from './email-provider.js';
import { sendVerificationCode } from './verification-codes.js';
import { authenticateWithEmail } from './auth-service.js';

const GENERIC_SEND_MESSAGE = '如果该邮箱可用，验证码已发送。';

export interface AuthRouteOptions {
  emailProvider: EmailProvider;
  freeQuotaEnabled: boolean;
  /**
   * LiteTavern Cloud hooks. Registration is an account fact; entering the Alpha
   * waitlist is a Cloud fact, so the Cloud module reacts here instead of the auth
   * module reaching into the program itself.
   */
  onCodeRequested?: (userId: string) => Promise<void>;
  onCodeSent?: (userId: string) => Promise<void>;
  onAuthenticated?: (
    userId: string,
    outcome: 'REGISTERED' | 'LOGGED_IN' | 'MERGED'
  ) => Promise<void>;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  options: AuthRouteOptions
) {
  // Request a verification code. The response is intentionally uniform regardless of
  // whether the email already has an account, so it cannot be used to enumerate
  // accounts. Only rate-limit errors surface a distinct code.
  app.post('/v1/auth/email-code/send', async (request) => {
    const body = emailCodeSendSchema.parse(request.body);
    const session = await resolveIdentityContext(request, database);
    await options.onCodeRequested?.(session.userId);
    try {
      await sendVerificationCode(database, options.emailProvider, {
        email: body.email,
        ip: request.ip,
        sessionIdentityId: session.anonymousId
      });
      await options.onCodeSent?.(session.userId);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never expose delivery internals (or account existence). Log without the code.
      request.log.error(
        { err: { name: 'VerificationEmailFailed' } },
        'verification email delivery failed'
      );
    }
    return { success: true, message: GENERIC_SEND_MESSAGE };
  });

  // Verify a code and complete sign-in: registers (in place), logs in, or logs in and
  // merges the anonymous data. Rotates the session cookie on success.
  app.post('/v1/auth/email-code/verify', async (request, reply) => {
    const body = emailCodeVerifySchema.parse(request.body);
    const session = await resolveIdentityContext(request, database);
    const result = await authenticateWithEmail(
      database,
      session,
      body.email,
      body.code
    );
    await options.onAuthenticated?.(result.context.userId, result.outcome);
    setAnonymousCookie(reply, result.token);
    const payload = await identityPayload(
      database,
      result.context,
      options.freeQuotaEnabled
    );
    return { ...payload, outcome: result.outcome };
  });

  // Sign out: revoke this device's session identity and clear the cookie. The client
  // then bootstraps a brand-new anonymous identity rather than reusing the old one.
  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[ANONYMOUS_COOKIE];
    if (token) {
      await database.query(
        `UPDATE app_user_identity
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE identity_type = 'ANONYMOUS'
           AND subject_hash = $1
           AND revoked_at IS NULL`,
        [hashToken(token)]
      );
    }
    reply.clearCookie(ANONYMOUS_COOKIE, { path: '/' });
    return { success: true };
  });
}
