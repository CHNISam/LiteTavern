import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../lib/errors.js';
import { resolveUserId } from './identity.js';

async function assertCharacterAccess(
  database: PomChatDatabase,
  userId: string,
  characterId: string
) {
  const result = await database.query<{ character_id: string }>(
    `SELECT character_id FROM agent_character
     WHERE character_id = $1 AND status = 'ACTIVE'
       AND (visibility = 'PLATFORM' OR owner_user_id = $2)`,
    [characterId, userId]
  );
  if (!result.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '角色不存在。', 404);
}

export function registerCoreRoutes(app: FastifyInstance, database: PomChatDatabase) {
  app.get('/v1/characters', async (request) => {
    const userId = await resolveUserId(request, database);
    const result = await database.query(
      `SELECT
         c.character_id, c.name, c.profile_summary, c.personality_summary,
         c.first_message, c.avatar_seed, c.version,
         (c.owner_user_id = $1) AS is_owned,
         conversation.conversation_id,
         conversation.last_message_at,
         latest.content_text AS last_message
       FROM agent_character c
       LEFT JOIN LATERAL (
         SELECT conversation_id, last_message_at
         FROM chat_conversation
         WHERE user_id = $1 AND character_id = c.character_id AND status = 'ACTIVE'
         ORDER BY last_message_at DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) conversation ON TRUE
       LEFT JOIN LATERAL (
         SELECT content_text
         FROM chat_message
         WHERE conversation_id = conversation.conversation_id
           AND status = 'COMPLETED' AND is_active_variant = TRUE
         ORDER BY sequence_no DESC LIMIT 1
       ) latest ON TRUE
       WHERE c.status = 'ACTIVE'
         AND (c.visibility = 'PLATFORM' OR c.owner_user_id = $1)
       ORDER BY conversation.last_message_at DESC NULLS LAST, c.created_at`,
      [userId]
    );
    return { characters: result.rows };
  });

  app.get<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const result = await database.query(
      `SELECT c.character_id, c.name, c.profile_summary, c.personality_summary,
                c.first_message, c.avatar_seed, c.version,
                r.summary_text AS relationship_summary,
                r.state_json AS relationship_state
         FROM agent_character c
         LEFT JOIN agent_relationship r
           ON r.character_id = c.character_id AND r.user_id = $2 AND r.deleted_at IS NULL
         WHERE c.character_id = $1 AND c.status = 'ACTIVE'
           AND (c.visibility = 'PLATFORM' OR c.owner_user_id = $2)`,
        [request.params.characterId, userId]
      );
      const character = result.rows[0];
      if (!character) throw new AppError('RESOURCE_NOT_FOUND', '角色不存在。', 404);
      return { character };
    }
  );

  // Soft-delete a character the caller owns. Platform characters and characters
  // owned by other users are never affected — they simply won't match the WHERE
  // clause and surface as "not found".
  app.delete<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const result = await database.query<{ character_id: string }>(
        `UPDATE agent_character
         SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP, version = version + 1
         WHERE character_id = $1 AND owner_user_id = $2
           AND status = 'ACTIVE' AND deleted_at IS NULL
         RETURNING character_id`,
        [request.params.characterId, userId]
      );
      if (!result.rows[0]) {
        throw new AppError('RESOURCE_NOT_FOUND', '角色不存在或无权删除。', 404);
      }
      return { deleted: true };
    }
  );

  app.post<{ Body: { character_id?: string } }>('/v1/conversations', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const characterId = request.body?.character_id;
    if (!characterId) throw new AppError('VALIDATION_ERROR', '请选择角色。');
    await assertCharacterAccess(database, userId, characterId);

    const existing = await database.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM chat_conversation
       WHERE user_id = $1 AND character_id = $2 AND status = 'ACTIVE'
       ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [userId, characterId]
    );
    if (existing.rows[0]) return existing.rows[0];

    const conversationId = randomUUID();
    const opening = await database.query<{ first_message: string | null; name: string }>(
      `SELECT first_message, name FROM agent_character WHERE character_id = $1`,
      [characterId]
    );
    // A character created without an opening line (empty first_message) starts with
    // an empty conversation — inserting a blank assistant message would render as a
    // never-ending "typing" bubble.
    const firstMessage = opening.rows[0]?.first_message?.trim() ?? '';
    const hasOpening = firstMessage.length > 0;
    await database.exec('BEGIN');
    try {
      await database.query(
        `INSERT INTO chat_conversation (
           conversation_id, user_id, character_id, title,
           next_sequence_no, next_turn_no, last_message_at
         ) VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP)`,
        [conversationId, userId, characterId, `与${opening.rows[0]?.name ?? '角色'}的对话`, hasOpening ? 2 : 1]
      );
      if (hasOpening) {
        await database.query(
          `INSERT INTO chat_message (
             message_id, conversation_id, sequence_no, turn_no, variant_no,
             role, content_text, status, completed_at
           ) VALUES ($1, $2, 1, 0, 0, 'ASSISTANT', $3, 'COMPLETED', CURRENT_TIMESTAMP)`,
          [randomUUID(), conversationId, firstMessage]
        );
      }
      await database.query(
        `INSERT INTO agent_relationship (
           relationship_id, user_id, character_id, summary_text, state_json
         ) VALUES ($1, $2, $3, $4, '{}'::jsonb)
         ON CONFLICT (user_id, character_id) DO NOTHING`,
        [randomUUID(), userId, characterId, '你们刚刚开始认识，正在建立共同的故事。']
      );
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
    reply.code(201);
    return { conversation_id: conversationId };
  });

  app.get<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const result = await database.query(
        `SELECT cv.conversation_id, cv.character_id, cv.title, cv.status,
                cv.last_message_at, c.name AS character_name,
                c.avatar_seed, c.profile_summary
         FROM chat_conversation cv
         JOIN agent_character c ON c.character_id = cv.character_id
         WHERE cv.conversation_id = $1 AND cv.user_id = $2
           AND cv.status <> 'DELETED' AND c.status = 'ACTIVE'`,
        [request.params.conversationId, userId]
      );
      const conversation = result.rows[0];
      if (!conversation) throw new AppError('RESOURCE_NOT_FOUND', '会话不存在。', 404);
      return { conversation };
    }
  );

  app.get<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId/messages',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const access = await database.query(
        `SELECT 1 FROM chat_conversation cv
         JOIN agent_character c ON c.character_id = cv.character_id
         WHERE cv.conversation_id = $1 AND cv.user_id = $2 AND c.status = 'ACTIVE'`,
        [request.params.conversationId, userId]
      );
      if (!access.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '会话不存在。', 404);
      const messages = await database.query(
        `SELECT message_id, reply_to_message_id, sequence_no, turn_no, variant_no,
                role, content_text, status, is_active_variant, error_code, created_at
         FROM chat_message
         WHERE conversation_id = $1 AND is_active_variant = TRUE
         ORDER BY sequence_no`,
        [request.params.conversationId]
      );
      return { messages: messages.rows };
    }
  );

  app.get<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId/memories',
    async (request) => {
      const userId = await resolveUserId(request, database);
      await assertCharacterAccess(database, userId, request.params.characterId);
      const result = await database.query(
        `SELECT memory_id, memory_scope, memory_kind, subject_key, content,
                status, importance, created_by, created_at
         FROM agent_memory
         WHERE user_id = $1 AND character_id = $2
           AND status IN ('ACTIVE', 'CANDIDATE') AND deleted_at IS NULL
         ORDER BY importance DESC, created_at DESC`,
        [userId, request.params.characterId]
      );
      return { memories: result.rows };
    }
  );

  app.post<{
    Params: { characterId: string };
    Body: { content?: string; memory_kind?: string; memory_scope?: string };
  }>('/v1/characters/:characterId/memories', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    await assertCharacterAccess(database, userId, request.params.characterId);
    const content = request.body?.content?.trim();
    if (!content) throw new AppError('VALIDATION_ERROR', '记忆内容不能为空。');
    const memoryId = randomUUID();
    await database.query(
      `INSERT INTO agent_memory (
         memory_id, user_id, character_id, memory_scope, memory_kind,
         content, status, importance, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 4, 'USER')`,
      [
        memoryId,
        userId,
        request.params.characterId,
        request.body.memory_scope ?? 'USER',
        request.body.memory_kind ?? 'OTHER',
        content
      ]
    );
    reply.code(201);
    return { memory_id: memoryId };
  });

  app.delete<{ Params: { memoryId: string } }>('/v1/memories/:memoryId', async (request) => {
    const userId = await resolveUserId(request, database);
    const result = await database.query<{ memory_id: string }>(
      `UPDATE agent_memory SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP,
                               updated_at = CURRENT_TIMESTAMP
       WHERE memory_id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING memory_id`,
      [request.params.memoryId, userId]
    );
    if (!result.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '记忆不存在。', 404);
    return { deleted: true };
  });
}
