import type { FastifyInstance } from 'fastify';
import {
  cloudSyncCheckpointSchema,
  cloudWaitlistJoinSchema
} from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import { resolveIdentityContext } from '../identity.js';
import type { CloudConfig } from './config.js';
import { recordCloudEvent } from './events.js';
import { buildExportBundle } from './export.js';
import { joinWaitlist } from './membership.js';
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
