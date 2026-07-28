import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';

/**
 * Server-side product analytics for LiteTavern Cloud.
 *
 * Some facts only the server witnesses — a Trial grant, an Alpha release, a quota
 * cycle reset, a backup. They go into the same `analytics_event` table the client
 * writes to, so one query answers a funnel question across both sources.
 *
 * Only behaviour and cost metadata is recorded. Chat text, verification codes, full
 * email addresses and API keys must never reach this function; property values are
 * limited to scalars and the property names are guarded, matching the client contract.
 */

export type CloudEventProperties = Record<string, string | number | boolean | null>;

const FORBIDDEN_PROPERTY =
  /(?:api.?key|authorization|access.?token|refresh.?token|password|content.?text|message.?text|email|code)/i;

function sanitize(properties: CloudEventProperties): CloudEventProperties {
  const clean: CloudEventProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_PROPERTY.test(key)) continue;
    if (value === undefined) continue;
    clean[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return clean;
}

export async function recordCloudEvent(
  database: PomChatDatabase,
  eventName: string,
  input: {
    userId?: string | null;
    properties?: CloudEventProperties;
  } = {}
): Promise<void> {
  try {
    await database.query(
      `INSERT INTO analytics_event (
         event_id, event_name, user_id, occurred_at, received_at,
         properties_json, schema_version
       ) VALUES (
         $1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $4::jsonb, 1
       )`,
      [
        randomUUID(),
        eventName,
        input.userId ?? null,
        JSON.stringify(sanitize(input.properties ?? {}))
      ]
    );
  } catch {
    // Analytics must never break the operation it observes.
  }
}
