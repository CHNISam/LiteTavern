import type { PomChatDatabase } from '@pomchat/database';

/**
 * Full user-data export. This is the user's escape hatch from LiteTavern Cloud: a
 * self-describing bundle they can keep, re-import, or move elsewhere.
 *
 * The envelope carries a format version, an export instant, the data types included
 * and a compatibility note, so a future importer can decide what it understands
 * without guessing. Importers must preserve unknown fields rather than dropping them.
 *
 * Secrets are never exported: BYOK API keys live only in the user's browser, and the
 * bundle carries the model configuration shape without any credential material.
 */

export const EXPORT_FORMAT = 'litetavern.export';
export const EXPORT_FORMAT_VERSION = '1.0.0';

export interface ExportBundle {
  format: string;
  format_version: string;
  exported_at: string;
  data_types: string[];
  compatibility: {
    /** Oldest reader version able to consume this bundle. */
    minimum_reader_version: string;
    app_version: string;
    notes: string;
  };
  user: Record<string, unknown>;
  characters: Record<string, unknown>[];
  conversations: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  memories: Record<string, unknown>[];
  relationships: Record<string, unknown>[];
  model_configurations: Record<string, unknown>[];
}

const DATA_TYPES = [
  'user',
  'characters',
  'conversations',
  'messages',
  'memories',
  'relationships',
  'model_configurations'
];

export async function buildExportBundle(
  database: PomChatDatabase,
  userId: string,
  appVersion = '0.1.0'
): Promise<ExportBundle> {
  const user = await database.query(
    `SELECT user_id, email, created_at FROM app_user WHERE user_id = $1`,
    [userId]
  );

  const characters = await database.query(
    `SELECT character_id, name, profile_summary, personality_summary,
            first_message, avatar_seed, visibility, version, created_at, updated_at
     FROM agent_character
     WHERE owner_user_id = $1 AND status <> 'DELETED'
     ORDER BY created_at`,
    [userId]
  );

  const conversations = await database.query(
    `SELECT conversation_id, character_id, title, status,
            last_message_at, created_at
     FROM chat_conversation
     WHERE user_id = $1 AND status <> 'DELETED'
     ORDER BY created_at`,
    [userId]
  );

  const messages = await database.query(
    `SELECT m.message_id, m.conversation_id, m.sequence_no, m.turn_no,
            m.turn_bubble_no, m.role, m.content_text, m.status,
            m.is_active_variant, m.created_at
     FROM chat_message m
     JOIN chat_conversation c ON c.conversation_id = m.conversation_id
     WHERE c.user_id = $1 AND c.status <> 'DELETED'
     ORDER BY m.conversation_id, m.sequence_no`,
    [userId]
  );

  const memories = await database.query(
    `SELECT memory_id, character_id, conversation_id, memory_scope, memory_kind,
            subject_key, content, status, importance, created_by, created_at
     FROM agent_memory
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [userId]
  );

  const relationships = await database.query(
    `SELECT relationship_id, character_id, summary_text, state_json,
            version, updated_at
     FROM agent_relationship
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at`,
    [userId]
  );

  // Credential material is deliberately absent — only the non-secret shape.
  const configurations = await database.query(
    `SELECT model_configuration_id, provider, model_name, display_name,
            base_url, settings_json, status, created_at
     FROM model_configuration
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [userId]
  );

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    data_types: DATA_TYPES,
    compatibility: {
      minimum_reader_version: '1.0.0',
      app_version: appVersion,
      notes:
        'BYOK API keys are never exported. Unknown fields must be preserved on import.'
    },
    user: (user.rows[0] as Record<string, unknown>) ?? {},
    characters: characters.rows as Record<string, unknown>[],
    conversations: conversations.rows as Record<string, unknown>[],
    messages: messages.rows as Record<string, unknown>[],
    memories: memories.rows as Record<string, unknown>[],
    relationships: relationships.rows as Record<string, unknown>[],
    model_configurations: configurations.rows as Record<string, unknown>[]
  };
}
