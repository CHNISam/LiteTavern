import type { FastifyInstance } from 'fastify';
import type { LiteTavernDatabase } from '@litetavern/database';
import { analyticsEventBatchSchema } from '@litetavern/contracts';
import { resolveIdentityContext } from './identity.js';

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  database: LiteTavernDatabase
) {
  app.post('/v1/analytics/events', async (request, reply) => {
    const identity = await resolveIdentityContext(request, database);
    const input = analyticsEventBatchSchema.parse(request.body);
    let accepted = 0;
    let duplicates = 0;

    await database.transaction(async (transaction) => {
      for (const event of input.events) {
        const inserted = await transaction.query<{ event_id: string }>(
          `INSERT INTO analytics_event (
             event_id, event_name, anonymous_id, user_id, session_id,
             occurred_at, received_at, page_name, page_path,
             character_id, conversation_id, source_channel, campaign_id,
             device_type, properties_json, schema_version
           ) VALUES (
             $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, $8,
             $9, $10, $11, $12, $13, $14::jsonb, 1
           )
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [
            event.event_id,
            event.event_name,
            identity.anonymousId,
            identity.userId,
            event.session_id,
            event.occurred_at,
            event.page_name ?? null,
            event.page_path ?? null,
            event.character_id ?? null,
            event.conversation_id ?? null,
            event.source_channel ?? null,
            event.campaign_id ?? null,
            typeof event.properties.device_type === 'string'
              ? event.properties.device_type
              : null,
            JSON.stringify(event.properties)
          ]
        );
        if (inserted.rows[0]) accepted += 1;
        else duplicates += 1;

        if (
          inserted.rows[0] &&
          event.event_name === 'app_session_started' &&
          event.source_channel
        ) {
          await transaction.query(
            `UPDATE app_user
             SET first_source_channel = $2,
                 first_campaign_id = $3,
                 attribution_set_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $1 AND first_source_channel IS NULL`,
            [
              identity.userId,
              event.source_channel,
              event.campaign_id ?? null
            ]
          );
        }
      }
    });

    reply.code(202);
    return { accepted, duplicates };
  });
}
