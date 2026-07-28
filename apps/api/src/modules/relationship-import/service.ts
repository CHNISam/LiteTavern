import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import {
  approximateTimeToTimestamp,
  toAgentMemoryImportance,
  type NormalizedRelationshipImport
} from './schema.js';

/** The migration event is a system note, never a line the character "said". */
export const MIGRATION_EVENT_TEXT = '你们的关系资料已从其他平台迁移到 LiteTavern。';

const INTERNAL_CARD_METADATA = {
  format: 'INTERNAL',
  container: 'INTERNAL',
  spec_version: 'pomchat-0.1.0',
  compatibility_level: 'FORMAL',
  parser_id: 'pomchat/relationship-import',
  parser_version: '0.1.0',
  unapplied_fields: []
} as const;

/**
 * Relationship context stored in `agent_relationship.state_json`. These are the
 * only keys the runtime context assembler reads back, which keeps source metadata
 * and other bookkeeping out of the character prompt.
 */
export interface RelationshipStateJson {
  preferred_name?: string;
  user_facts?: string[];
  user_preferences?: string[];
  user_boundaries?: string[];
  stage?: string;
  interaction_patterns?: string[];
  unfinished_threads?: string[];
  migration?: { import_id: string; migrated_at: string };
}

/**
 * Personality and speaking style arrive as lists but `agent_character` keeps one
 * personality text (shared with character cards), so they are folded into a single
 * labelled block rather than a bag of prompt fragments.
 */
export function buildPersonalitySummary(
  data: NormalizedRelationshipImport
): string {
  const lines: string[] = [];
  if (data.character.personality_traits.length) {
    lines.push(`性格特征：${data.character.personality_traits.join('、')}`);
  }
  if (data.character.speaking_style.length) {
    lines.push(`表达习惯：${data.character.speaking_style.join('、')}`);
  }
  return lines.join('\n');
}

export function buildRelationshipState(
  data: NormalizedRelationshipImport,
  importId: string
): RelationshipStateJson {
  const state: RelationshipStateJson = {
    migration: { import_id: importId, migrated_at: new Date().toISOString() }
  };
  if (data.user_profile.preferred_name) state.preferred_name = data.user_profile.preferred_name;
  if (data.user_profile.facts.length) state.user_facts = data.user_profile.facts;
  if (data.user_profile.preferences.length) {
    state.user_preferences = data.user_profile.preferences;
  }
  if (data.user_profile.boundaries.length) {
    state.user_boundaries = data.user_profile.boundaries;
  }
  if (data.relationship.stage) state.stage = data.relationship.stage;
  if (data.relationship.interaction_patterns.length) {
    state.interaction_patterns = data.relationship.interaction_patterns;
  }
  if (data.unfinished_threads.length) state.unfinished_threads = data.unfinished_threads;
  return state;
}

/** A memory's kind is inferred from its own text, never from instructions in it. */
function memoryKind(content: string, tags: string[]): string {
  const haystack = `${content} ${tags.join(' ')}`;
  if (/约定|承诺|答应|说好|计划|约好/.test(haystack)) return 'COMMITMENT';
  if (/喜欢|讨厌|偏好|习惯|口味/.test(haystack)) return 'PREFERENCE';
  if (/一起|那天|那次|经历|回忆/.test(haystack)) return 'EXPERIENCE';
  return 'FACT';
}

export interface CommitTarget {
  mode: 'CREATE' | 'EXISTING';
  characterId?: string;
  updateExistingCharacter: boolean;
}

export interface CommitResult {
  import_id: string;
  character_id: string;
  conversation_id: string;
  created_character: boolean;
  memories_written: number;
  relationship_updated: boolean;
  uncertain_items_kept: number;
  already_committed: boolean;
}

interface ImportRecord {
  import_id: string;
  status: string;
  target_character_id: string | null;
  conversation_id: string | null;
  created_character: boolean;
  memory_count: number;
  normalized_payload: NormalizedRelationshipImport | null;
}

export async function readImportRecord(
  database: PomChatDatabase,
  userId: string,
  importId: string
): Promise<ImportRecord> {
  const result = await database.query<ImportRecord>(
    `SELECT import_id, status, target_character_id, conversation_id,
            created_character, memory_count, normalized_payload
     FROM relationship_import
     WHERE import_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [importId, userId]
  );
  const record = result.rows[0];
  if (!record) throw new AppError('RESOURCE_NOT_FOUND', '迁移任务不存在或已删除。', 404);
  return record;
}

/**
 * Verifies the caller owns the target character. Platform characters and other
 * users' characters simply do not match, so they surface as "not found" and can
 * never be overwritten by an import.
 */
async function assertOwnedCharacter(
  transaction: { query: PomChatDatabase['query'] },
  userId: string,
  characterId: string
): Promise<{ version_no: number; card_version_id: string | null }> {
  const result = await transaction.query<{
    version_no: number | null;
    card_version_id: string | null;
  }>(
    `SELECT v.version_no, v.card_version_id
     FROM agent_character c
     LEFT JOIN agent_character_card_version v
       ON v.card_version_id = c.active_card_version_id
     WHERE c.character_id = $1 AND c.owner_user_id = $2
       AND c.status = 'ACTIVE' AND c.deleted_at IS NULL`,
    [characterId, userId]
  );
  if (!result.rows[0]) {
    throw new AppError(
      'RESOURCE_NOT_FOUND',
      '目标角色不存在，或不是你创建的角色。平台角色与他人角色不能作为迁移目标。',
      404
    );
  }
  return {
    version_no: result.rows[0].version_no ?? 0,
    card_version_id: result.rows[0].card_version_id
  };
}

function normalizedCardData(data: NormalizedRelationshipImport) {
  return {
    name: data.character.name,
    description: data.character.description,
    personality: buildPersonalitySummary(data),
    scenario: '',
    // A migrated relationship has no opening line: LiteTavern must not invent one.
    first_message: '',
    alternate_greetings: [],
    example_messages: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: [],
    creator: { name: '', notes: '', character_version: '' }
  };
}

/**
 * Writes the confirmed migration in a single transaction: character (created or
 * optionally refreshed), relationship summary + context, long-term memories, a new
 * conversation with a system migration event, and the import record's final state.
 * Any failure rolls the whole thing back, leaving no partial relationship.
 */
export async function commitRelationshipImport(
  database: PomChatDatabase,
  userId: string,
  importId: string,
  data: NormalizedRelationshipImport,
  target: CommitTarget,
  options: { keepUncertainItems: boolean; rawPayload: unknown }
): Promise<CommitResult> {
  const existing = await readImportRecord(database, userId, importId);
  // Re-submitting a committed import returns the original outcome instead of
  // writing the character, relationship and memories a second time.
  if (existing.status === 'COMMITTED') {
    return {
      import_id: importId,
      character_id: existing.target_character_id ?? '',
      conversation_id: existing.conversation_id ?? '',
      created_character: existing.created_character,
      memories_written: existing.memory_count,
      relationship_updated: true,
      uncertain_items_kept: existing.normalized_payload?.uncertain_items.length ?? 0,
      already_committed: true
    };
  }
  if (existing.status !== 'VALIDATED') {
    throw new AppError('IDEMPOTENCY_CONFLICT', '该迁移任务已结束，无法再次提交。', 409);
  }

  const storedPayload: NormalizedRelationshipImport = options.keepUncertainItems
    ? data
    : { ...data, uncertain_items: [] };
  const conversationId = randomUUID();
  let characterId = target.characterId ?? '';
  let createdCharacter = false;
  let memoriesWritten = 0;

  await database.transaction(async (transaction) => {
    // Claim the record first: a concurrent double-submit finds it no longer
    // VALIDATED and cannot repeat the writes below.
    const claimed = await transaction.query<{ import_id: string }>(
      `UPDATE relationship_import
       SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP
       WHERE import_id = $1 AND user_id = $2 AND status = 'VALIDATED'
         AND deleted_at IS NULL
       RETURNING import_id`,
      [importId, userId]
    );
    if (!claimed.rows[0]) {
      throw new AppError('IDEMPOTENCY_CONFLICT', '该迁移任务已被提交。', 409);
    }

    const cardVersionId = randomUUID();
    const cardData = normalizedCardData(data);

    if (target.mode === 'CREATE') {
      characterId = randomUUID();
      createdCharacter = true;
      await transaction.query(
        `INSERT INTO agent_character (
           character_id, owner_user_id, visibility, name, profile_summary,
           personality_summary, first_message, avatar_seed, status
         ) VALUES ($1, $2, 'PRIVATE', $3, $4, $5, '', $3, 'ACTIVE')`,
        [characterId, userId, cardData.name, cardData.description, cardData.personality]
      );
      await transaction.query(
        `INSERT INTO agent_character_card_version (
           card_version_id, character_id, version_no, source_format,
           source_spec_version, import_status, normalized_data,
           passthrough_data, source_metadata, preserved_data, parser_version
         ) VALUES (
           $1, $2, 1, 'INTERNAL', $3, 'READY', $4::jsonb,
           '{"root":{},"data":{}}'::jsonb, $5::jsonb, '{}'::jsonb, $6
         )`,
        [
          cardVersionId,
          characterId,
          INTERNAL_CARD_METADATA.spec_version,
          JSON.stringify(cardData),
          JSON.stringify(INTERNAL_CARD_METADATA),
          INTERNAL_CARD_METADATA.parser_version
        ]
      );
      await transaction.query(
        `UPDATE agent_character
         SET active_card_version_id = $2, version = version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE character_id = $1`,
        [characterId, cardVersionId]
      );
    } else {
      if (!target.characterId) {
        throw new AppError('VALIDATION_ERROR', '请选择要导入的已有角色。');
      }
      const current = await assertOwnedCharacter(transaction, userId, target.characterId);
      characterId = target.characterId;
      // Character setup is only rewritten when the user explicitly asked for it,
      // so a migration never silently replaces a card they already tuned.
      if (target.updateExistingCharacter) {
        await transaction.query(
          `INSERT INTO agent_character_card_version (
             card_version_id, character_id, version_no, source_format,
             source_spec_version, import_status, normalized_data,
             passthrough_data, source_metadata, preserved_data, parser_version
           ) VALUES (
             $1, $2, $3, 'INTERNAL', $4, 'READY', $5::jsonb,
             '{"root":{},"data":{}}'::jsonb, $6::jsonb, '{}'::jsonb, $7
           )`,
          [
            cardVersionId,
            characterId,
            current.version_no + 1,
            INTERNAL_CARD_METADATA.spec_version,
            JSON.stringify(cardData),
            JSON.stringify(INTERNAL_CARD_METADATA),
            INTERNAL_CARD_METADATA.parser_version
          ]
        );
        await transaction.query(
          `UPDATE agent_character
           SET active_card_version_id = $2, name = $3, profile_summary = $4,
               personality_summary = $5, version = version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE character_id = $1`,
          [characterId, cardVersionId, cardData.name, cardData.description, cardData.personality]
        );
      }
    }

    const state = buildRelationshipState(data, importId);
    await transaction.query(
      `INSERT INTO agent_relationship (
         relationship_id, user_id, character_id, summary_text, state_json
       ) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (user_id, character_id) DO UPDATE
       SET summary_text = EXCLUDED.summary_text,
           state_json = agent_relationship.state_json || EXCLUDED.state_json,
           version = agent_relationship.version + 1,
           updated_at = CURRENT_TIMESTAMP,
           deleted_at = NULL`,
      [randomUUID(), userId, characterId, data.relationship.summary, JSON.stringify(state)]
    );

    for (const memory of data.memories) {
      await transaction.query(
        `INSERT INTO agent_memory (
           memory_id, user_id, character_id, memory_scope, memory_kind,
           content, status, importance, created_by, valid_from,
           relationship_import_id
         ) VALUES ($1, $2, $3, 'USER', $4, $5, 'ACTIVE', $6, 'USER', $7, $8)`,
        [
          randomUUID(),
          userId,
          characterId,
          memoryKind(memory.content, memory.tags),
          memory.content,
          toAgentMemoryImportance(memory.importance),
          approximateTimeToTimestamp(memory.approximate_time),
          importId
        ]
      );
      memoriesWritten += 1;
    }

    await transaction.query(
      `INSERT INTO chat_conversation (
         conversation_id, user_id, character_id, title,
         next_sequence_no, next_turn_no, last_message_at
       ) VALUES ($1, $2, $3, $4, 2, 1, CURRENT_TIMESTAMP)`,
      [conversationId, userId, characterId, `与${data.character.name}的对话`]
    );
    // An EVENT row, not an ASSISTANT one: the old platform's chat history is never
    // reconstructed, and the character is never credited with words it did not say.
    await transaction.query(
      `INSERT INTO chat_message (
         message_id, conversation_id, sequence_no, turn_no, variant_no,
         role, content_text, status, completed_at
       ) VALUES ($1, $2, 1, 0, 0, 'EVENT', $3, 'COMPLETED', CURRENT_TIMESTAMP)`,
      [randomUUID(), conversationId, MIGRATION_EVENT_TEXT]
    );

    await transaction.query(
      `UPDATE relationship_import
       SET target_character_id = $2, conversation_id = $3,
           created_character = $4, memory_count = $5,
           normalized_payload = $6::jsonb, raw_payload = $7::jsonb
       WHERE import_id = $1`,
      [
        importId,
        characterId,
        conversationId,
        createdCharacter,
        memoriesWritten,
        JSON.stringify(storedPayload),
        JSON.stringify(options.rawPayload ?? {})
      ]
    );
  });

  return {
    import_id: importId,
    character_id: characterId,
    conversation_id: conversationId,
    created_character: createdCharacter,
    memories_written: memoriesWritten,
    relationship_updated: true,
    uncertain_items_kept: storedPayload.uncertain_items.length,
    already_committed: false
  };
}
