import type { FastifyInstance } from 'fastify';
import {
  alphaFeedbackCreateSchema,
  cloudSyncCheckpointSchema,
  cloudWaitlistJoinSchema
} from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { resolveIdentityContext } from '../identity.js';
import type { CloudConfig } from './config.js';
import { recordCloudEvent } from './events.js';
import { buildExportBundle } from './export.js';
import { submitFeedback } from './feedback.js';
import {
  activateAlpha,
  ensureMembership,
  joinWaitlist,
  readBatchPolicy
} from './membership.js';
import { getCloudStatus } from './status.js';
import { countSupporters, listThanks } from './supporter.js';
import { listSyncState, recordSyncCheckpoint } from './sync.js';

/**
 * Public LiteTavern Cloud API — the surface the open-source client talks to.
 *
 * The client never decides entitlement, quota size or program stage on its own; it
 * reads all of that from here. Every route requires a resolved identity (anonymous or
 * registered), which the existing cookie-based identity layer already provides.
 */
export function registerCloudRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  config: CloudConfig
) {
  app.get('/v1/cloud/status', async (request) => {
    const identity = await resolveIdentityContext(request, database);
    return { cloud: await getCloudStatus(database, config, identity) };
  });

  // Joining the Alpha waitlist is an explicit, idempotent action. Registration alone
  // already places a user on the waitlist; this route exists for a user who registered
  // before the program started, or who dismissed the prompt.
  app.post('/v1/cloud/waitlist', async (request, reply) => {
    const identity = await resolveIdentityContext(request, database);
    const body = cloudWaitlistJoinSchema.parse(request.body ?? {});
    const result = await joinWaitlist(
      database,
      identity.userId,
      body.channel
    );
    if (result.joined) {
      await recordCloudEvent(database, 'alpha_waitlist_joined', {
        userId: identity.userId,
        properties: { channel: body.channel ?? 'app' }
      });
    }
    reply.code(result.joined ? 201 : 200);
    return {
      joined: result.joined,
      cloud: await getCloudStatus(database, config, identity)
    };
  });

  /**
   * "Enter Alpha" — the user's own activation step.
   *
   * Whether the caller may do this is decided entirely here, from the membership row:
   * only ALPHA_GRANTED can activate. A client that fakes its local state simply gets
   * a 403, because nothing about entitlement is taken from the request.
   *
   * Idempotent: a second call reports `already_active` and keeps the first
   * `activated_at`, which is the timestamp the effective-tester计算 relies on.
   */
  app.post('/v1/cloud/alpha/activate', async (request, reply) => {
    const identity = await resolveIdentityContext(request, database);
    const membership = await ensureMembership(
      database,
      identity.userId,
      identity.registered
    );
    const policy = membership.batchId
      ? await readBatchPolicy(database, membership.batchId, config.defaultAlphaPolicy)
      : config.defaultAlphaPolicy;

    const result = await activateAlpha(database, {
      userId: identity.userId,
      policy
    });
    if (result.activated) {
      await recordCloudEvent(database, 'alpha_activated', {
        userId: identity.userId,
        properties: {
          batch_id: result.membership.batchId ?? '',
          grant_source: result.membership.grantSource ?? ''
        }
      });
    }
    reply.code(result.activated ? 201 : 200);
    return {
      activated: result.activated,
      already_active: result.alreadyActive,
      cloud: await getCloudStatus(database, config, identity)
    };
  });

  /**
   * Alpha feedback from a tester. Restricted to users who actually hold a seat: the
   * release gate counts these rows, so anonymous or waitlisted submissions would let
   * anyone inflate the outstanding-feedback number.
   */
  app.post('/v1/cloud/alpha/feedback', async (request, reply) => {
    const identity = await resolveIdentityContext(request, database);
    const membership = await ensureMembership(
      database,
      identity.userId,
      identity.registered
    );
    if (
      !['ALPHA_GRANTED', 'ALPHA_ACTIVE', 'ALPHA_PAUSED', 'ALPHA_ENDED'].includes(
        membership.status
      )
    ) {
      throw new AppError(
        'ALPHA_NOT_GRANTED',
        '只有 LiteTavern Cloud Alpha 参与者可以提交 Alpha 反馈。',
        403
      );
    }
    const body = alphaFeedbackCreateSchema.parse(request.body);

    const grant = await database.query<{ batch_no: number | null }>(
      `SELECT batch_no FROM alpha_grant
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [identity.userId]
    );
    const feedback = await submitFeedback(database, {
      userId: identity.userId,
      title: body.title,
      source: 'ALPHA_USER',
      ...(body.detail ? { detail: body.detail } : {}),
      batchNo: body.batch_no ?? grant.rows[0]?.batch_no ?? null
    });
    reply.code(201);
    // Only the submitter's own row comes back; the register itself is operator-only.
    return { feedback: { feedback_id: feedback.feedback_id, created_at: feedback.created_at } };
  });

  // Support entry configuration. The payment platform is a plain external URL, so no
  // single provider is baked into the product.
  app.get('/v1/cloud/support', async (request) => {
    const identity = await resolveIdentityContext(request, database);
    const enabled = config.support.enabled && config.support.url.length > 0;
    return {
      support: {
        enabled,
        url: config.support.url,
        headline: config.support.headline,
        body: config.support.body,
        thanks_list_enabled: config.support.thanksListEnabled,
        supporter_count: await countSupporters(database),
        // Automation status is stated plainly: contributions are confirmed by hand.
        confirmation: 'MANUAL',
        thanks: config.support.thanksListEnabled ? await listThanks(database) : []
      },
      is_founding_supporter: (
        await getCloudStatus(database, config, identity)
      ).founding_supporter
    };
  });

  // Full data export. Format-versioned and self-describing; contains no secrets.
  app.get('/v1/cloud/export', async (request, reply) => {
    const identity = await resolveIdentityContext(request, database);
    const bundle = await buildExportBundle(database, identity.userId);
    reply
      .header(
        'Content-Disposition',
        `attachment; filename="litetavern-export-${Date.now()}.json"`
      )
      .type('application/json; charset=utf-8');
    return bundle;
  });

  app.get('/v1/cloud/sync', async (request) => {
    const identity = await resolveIdentityContext(request, database);
    return { devices: await listSyncState(database, identity.userId) };
  });

  // A device reports how far it has reconciled. Retrying a failed checkpoint is safe:
  // the row is keyed on (user, device) and simply updated.
  app.post('/v1/cloud/sync/checkpoint', async (request) => {
    const identity = await resolveIdentityContext(request, database);
    const body = cloudSyncCheckpointSchema.parse(request.body);
    const checkpoint = await recordSyncCheckpoint(database, {
      userId: identity.userId,
      deviceKey: body.device_key,
      status: body.status,
      ...(body.client_revision === undefined
        ? {}
        : { clientRevision: body.client_revision }),
      ...(body.pending_count === undefined
        ? {}
        : { pendingCount: body.pending_count }),
      errorCode: body.error_code ?? null
    });
    await recordCloudEvent(
      database,
      body.status === 'FAILED' ? 'cloud_sync_failed' : 'cloud_sync_succeeded',
      {
        userId: identity.userId,
        properties: {
          pending_count: checkpoint.pending_count,
          stale: checkpoint.stale,
          error_code: body.error_code ?? ''
        }
      }
    );
    return { sync: checkpoint };
  });
}
