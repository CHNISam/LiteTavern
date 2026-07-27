import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp } from '../app.js';
import { getAnalyticsOverview } from './analytics-metrics.js';

let database: PomChatDatabase | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  await database?.close();
  app = undefined;
  database = undefined;
});

async function setupApi() {
  database = await createDatabase({ dataDir: 'memory://' });
  app = await buildApp({ database });
  const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
  const cookie = String(identity.headers['set-cookie']).split(';')[0];
  return {
    app,
    database,
    cookie,
    userId: identity.json().user.user_id as string,
    anonymousId: identity.json().user.anonymous_id as string
  };
}

describe('analytics ingestion', () => {
  it('deduplicates events and freezes the first source attribution', async () => {
    const { app, database, cookie, userId, anonymousId } = await setupApi();
    const eventId = randomUUID();
    const firstPayload = {
      events: [
        {
          event_id: eventId,
          event_name: 'app_session_started',
          session_id: 'session-first',
          occurred_at: '2026-07-27T01:00:00.000Z',
          source_channel: 'bilibili',
          campaign_id: 'firefly_launch',
          properties: {
            is_first_visit: true,
            session_number: 1,
            entry_source: 'utm_source',
            current_source_channel: 'bilibili',
            first_source_channel: 'bilibili',
            landing_page: '/'
          }
        }
      ]
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: { cookie },
      payload: firstPayload
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: { cookie },
      payload: firstPayload
    });
    const laterDirect = await app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: { cookie },
      payload: {
        events: [
          {
            event_id: randomUUID(),
            event_name: 'app_session_started',
            session_id: 'session-later',
            occurred_at: '2026-07-28T01:00:00.000Z',
            source_channel: 'direct',
            properties: {
              is_first_visit: false,
              session_number: 2,
              entry_source: 'direct',
              current_source_channel: 'direct',
              first_source_channel: 'bilibili',
              landing_page: '/'
            }
          }
        ]
      }
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(laterDirect.statusCode).toBe(202);

    const attribution = await database.query<{
      first_source_channel: string;
      first_campaign_id: string;
    }>(
      `SELECT first_source_channel, first_campaign_id
       FROM app_user WHERE user_id = $1`,
      [userId]
    );
    expect(attribution.rows[0]).toEqual({
      first_source_channel: 'bilibili',
      first_campaign_id: 'firefly_launch'
    });
    const stored = await database.query<{
      count: number;
      anonymous_id: string;
      user_id: string;
    }>(
      `SELECT COUNT(*)::int AS count, MIN(anonymous_id::text) AS anonymous_id,
              MIN(user_id::text) AS user_id
       FROM analytics_event`,
      []
    );
    expect(stored.rows[0]).toMatchObject({
      count: 2,
      anonymous_id: anonymousId,
      user_id: userId
    });
  });

  it('stores page order and depth without chat content', async () => {
    const { app, database, cookie } = await setupApi();
    const pages = ['home', 'character_detail', 'chat'] as const;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/analytics/events',
      headers: { cookie },
      payload: {
        events: pages.map((page, index) => ({
          event_id: randomUUID(),
          event_name: 'page_view',
          session_id: 'session-path',
          occurred_at: `2026-07-27T01:00:0${index}.000Z`,
          page_name: page,
          page_path: `/${page}`,
          properties: {
            from_page: index ? pages[index - 1] : null,
            entry_method: index ? 'navigation' : 'deep_link',
            page_view_index: index + 1,
            page_depth: index + 1,
            time_since_session_start_ms: index * 1000
          }
        }))
      }
    });

    expect(response.statusCode).toBe(202);
    const stored = await database.query<{
      page_name: string;
      properties_json: Record<string, unknown>;
    }>(
      `SELECT page_name, properties_json
       FROM analytics_event
       WHERE session_id = 'session-path'
       ORDER BY occurred_at`
    );
    expect(stored.rows.map((row) => row.page_name)).toEqual(pages);
    expect(stored.rows.at(-1)?.properties_json).toMatchObject({
      from_page: 'character_detail',
      page_view_index: 3,
      page_depth: 3
    });
    expect(JSON.stringify(stored.rows)).not.toContain('content_text');
  });
});

async function insertCompletedTurn(
  database: PomChatDatabase,
  input: {
    userId: string;
    conversationId: string;
    turn: number;
    at: string;
    sessionId: string;
  }
) {
  const userMessageId = randomUUID();
  const generationId = randomUUID();
  await database.query(
    `INSERT INTO chat_message (
       message_id, conversation_id, sequence_no, turn_no, role,
       content_text, status, completed_at, created_at
     ) VALUES ($1, $2, $3, $3, 'USER', 'redacted-test-message',
               'COMPLETED', $4, $4)`,
    [userMessageId, input.conversationId, input.turn * 2 - 1, input.at]
  );
  await database.query(
    `INSERT INTO agent_generation_request (
       generation_request_id, user_id, conversation_id, input_message_id,
       usage_mode, idempotency_key, status, prompt_version,
       provider, model_name, client_session_id,
       created_at, started_at, completed_at
     ) VALUES ($1, $2, $3, $4, 'PLATFORM', $5, 'COMPLETED',
               'pomchat-v0.1.0', 'groq', 'configured-model', $6, $7, $7, $7)`,
    [
      generationId,
      input.userId,
      input.conversationId,
      userMessageId,
      `turn-${input.turn}`,
      input.sessionId,
      input.at
    ]
  );
  await database.query(
    `INSERT INTO chat_message (
       message_id, conversation_id, generation_request_id,
       reply_to_message_id, sequence_no, turn_no, role,
       content_text, status, completed_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'ASSISTANT',
               'redacted-test-reply', 'COMPLETED', $7, $7)`,
    [
      randomUUID(),
      input.conversationId,
      generationId,
      userMessageId,
      input.turn * 2,
      input.turn,
      input.at
    ]
  );
}

describe('analytics metrics', () => {
  it('reproduces activation, effective chat, D1, and same-character retention', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const userId = randomUUID();
    const characterId = randomUUID();
    const conversationId = randomUUID();
    await database.query(
      `INSERT INTO app_user (
         user_id, created_at, first_source_channel, first_campaign_id, attribution_set_at
       ) VALUES ($1, '2026-07-27T01:00:00Z', 'bilibili', 'firefly_launch',
                 '2026-07-27T01:00:00Z')`,
      [userId]
    );
    await database.query(
      `INSERT INTO agent_character (
         character_id, visibility, name, status
       ) VALUES ($1, 'PLATFORM', 'Firefly', 'ACTIVE')`,
      [characterId]
    );
    await database.query(
      `INSERT INTO chat_conversation (
         conversation_id, user_id, character_id, next_sequence_no, next_turn_no, created_at
       ) VALUES ($1, $2, $3, 9, 5, '2026-07-27T01:00:00Z')`,
      [conversationId, userId, characterId]
    );

    await insertCompletedTurn(database, {
      userId,
      conversationId,
      turn: 1,
      at: '2026-07-27T01:05:00Z',
      sessionId: 'session-day-0'
    });
    await insertCompletedTurn(database, {
      userId,
      conversationId,
      turn: 2,
      at: '2026-07-27T01:06:00Z',
      sessionId: 'session-day-0'
    });
    await insertCompletedTurn(database, {
      userId,
      conversationId,
      turn: 3,
      at: '2026-07-27T01:07:00Z',
      sessionId: 'session-day-0'
    });
    await insertCompletedTurn(database, {
      userId,
      conversationId,
      turn: 4,
      at: '2026-07-28T01:05:00Z',
      sessionId: 'session-day-1'
    });

    const result = await getAnalyticsOverview(database, {
      from: '2026-07-27T00:00:00Z',
      to: '2026-08-05T00:00:00Z',
      effectiveChatTurns: 3
    });

    expect(result.newUsers).toMatchObject({ total: 1 });
    expect(result.channels).toContainEqual(
      expect.objectContaining({
        sourceChannel: 'bilibili',
        campaignId: 'firefly_launch',
        newUsers: 1,
        activatedUsers: 1
      })
    );
    expect(result.activation).toMatchObject({ activatedUsers: 1 });
    expect(result.effectiveChat).toMatchObject({
      effectiveUsers: 1,
      sameCharacterRevisits: 1
    });
    expect(result.retention).toMatchObject({
      d1ContinuedUsers: 1,
      d1SameCharacterUsers: 1,
      d7ContinuedUsers: 0,
      d7SameCharacterUsers: 0
    });
  });
});
