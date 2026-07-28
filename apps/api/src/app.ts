import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { AppError } from './lib/errors.js';
import { registerIdentityRoutes } from './modules/identity.js';
import { registerCoreRoutes } from './modules/core-routes.js';
import { registerModelRoutes } from './modules/model-routes.js';
import { registerGenerationRoutes } from './modules/generation-routes.js';
import { registerCharacterCardRoutes } from './modules/character-card-routes.js';
import { registerAnalyticsRoutes } from './modules/analytics-routes.js';
import { registerRelationshipImportRoutes } from './modules/relationship-import/routes.js';
import { registerAuthRoutes } from './modules/auth/auth-routes.js';
import { loadEmailProvider, type EmailProvider } from './modules/auth/email-provider.js';
import {
  createModelGateway,
  type ModelGateway
} from './modules/providers/model-gateway.js';
import { loadPlatformProviderConfig, type PlatformProviderConfig } from './modules/providers/credentials.js';
import { loadCloudConfig, type CloudConfig } from './modules/cloud/config.js';
import { registerCloudRoutes } from './modules/cloud/routes.js';
import { registerCloudAdminRoutes } from './modules/cloud/admin-routes.js';
import { recordCloudEvent } from './modules/cloud/events.js';
import {
  ensureMembership,
  onRegistrationCompleted
} from './modules/cloud/membership.js';
import { seedPlatformData } from './seed.js';
import {
  createFileCharacterAssetStore,
  createMemoryCharacterAssetStore,
  type CharacterAssetStore
} from './modules/character-assets.js';

export interface BuildAppOptions {
  database?: PomChatDatabase;
  gateway?: ModelGateway;
  platform?: PlatformProviderConfig;
  logger?: boolean;
  assetStore?: CharacterAssetStore;
  emailProvider?: EmailProvider;
  cloud?: CloudConfig;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const ownsDatabase = !options.database;
  const database =
    options.database ??
    (await createDatabase({ dataDir: process.env.POMCHAT_DATA_DIR ?? '.pomchat/database' }));
  const gateway = options.gateway ?? createModelGateway();
  const platform = options.platform ?? loadPlatformProviderConfig();
  const cloud = options.cloud ?? loadCloudConfig();
  const emailProvider = options.emailProvider ?? loadEmailProvider().provider;
  const assetStore = options.assetStore ??
    (process.env.NODE_ENV === 'test'
      ? createMemoryCharacterAssetStore()
      : createFileCharacterAssetStore(
          process.env.POMCHAT_ASSET_DIR ?? '.pomchat/assets'
        ));

  const app = Fastify({
    logger: options.logger
      ? {
          level: process.env.LOG_LEVEL ?? 'info',
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.x-pomchat-credential',
              'req.body.credential.api_key',
              'req.body.api_key',
              'res.headers.set-cookie'
            ],
            censor: '[REDACTED]'
          }
        }
      : false,
    bodyLimit: 10 * 1024 * 1024,
    requestIdHeader: 'x-request-id'
  });

  const webOrigin = new URL(
    process.env.POMCHAT_WEB_ORIGIN ?? 'http://127.0.0.1:5173'
  ).origin;

  await app.register(cookie);
  await app.register(cors, {
    origin: webOrigin,
    credentials: true
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', async (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    let browserOrigin: string | undefined;
    if (typeof origin === 'string') {
      browserOrigin = origin;
    } else if (typeof referer === 'string') {
      try {
        browserOrigin = new URL(referer).origin;
      } catch {
        browserOrigin = 'invalid';
      }
    }
    // Requests without browser provenance headers remain available to native/API clients.
    if (browserOrigin !== undefined && browserOrigin !== webOrigin) {
      throw new AppError(
        'CROSS_ORIGIN_REQUEST_REJECTED',
        '拒绝来自非受信任来源的请求。',
        403
      );
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
    return payload;
  });

  await seedPlatformData(database);
  app.decorate('pomchat', { database, gateway, platform, cloud });

  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    // The client uses this to tell "LiteTavern Cloud is down" apart from "my network
    // is down", so it can degrade to local + BYOK instead of reporting data loss.
    cloud: { stage: cloud.stage, platform_models: cloud.trialEnabled }
  }));
  registerIdentityRoutes(app, database, {
    initialQuota: platform.initialQuota ?? 30,
    freeQuotaEnabled: platform.freeQuotaEnabled ?? true,
    onAnonymousCreated: async (userId, initialQuota) => {
      await ensureMembership(database, userId, false);
      await recordCloudEvent(database, 'anonymous_created', { userId });
      await recordCloudEvent(database, 'cloud_trial_granted', {
        userId,
        properties: { trial_units: initialQuota, stage: cloud.stage }
      });
    }
  });
  registerAuthRoutes(app, database, {
    emailProvider,
    freeQuotaEnabled: platform.freeQuotaEnabled ?? true,
    onCodeRequested: async (userId) => {
      await recordCloudEvent(database, 'registration_started', { userId });
    },
    onCodeSent: async (userId) => {
      await recordCloudEvent(database, 'verification_code_sent', { userId });
    },
    // Registration never grants Alpha: a newly verified account lands on the
    // waitlist, keeping its user_id and all of its anonymous data.
    onAuthenticated: async (userId, outcome) => {
      const membership = await onRegistrationCompleted(database, userId);
      if (outcome === 'REGISTERED') {
        await recordCloudEvent(database, 'registration_completed', { userId });
        if (membership.status === 'REGISTERED_WAITLIST') {
          await recordCloudEvent(database, 'alpha_waitlist_joined', {
            userId,
            properties: { channel: 'registration' }
          });
        }
      }
    }
  });
  registerAnalyticsRoutes(app, database);
  registerCoreRoutes(app, database);
  registerModelRoutes(app, database, gateway);
  registerGenerationRoutes(app, { database, gateway, platform, cloud });
  registerCloudRoutes(app, database, cloud);
  registerCloudAdminRoutes(app, database, cloud);
  registerCharacterCardRoutes(app, database, assetStore);
  registerRelationshipImportRoutes(app, database);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数不符合要求。',
          retryable: false,
          request_id: request.id,
          fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
        }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          request_id: request.id
        }
      });
    }
    request.log.error(
      { err: { name: error instanceof Error ? error.name : 'UnknownError' } },
      'request failed'
    );
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用。',
        retryable: false,
        request_id: request.id
      }
    });
  });

  if (ownsDatabase) app.addHook('onClose', () => database.close());
  return app;
}
