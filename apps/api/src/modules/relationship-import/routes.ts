import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { resolveUserId } from '../identity.js';
import {
  IMPORT_LIMITS,
  RELATIONSHIP_IMPORT_SCHEMA_VERSION,
  normalizeRelationshipImport,
  parseRelationshipImportText,
  type ImportIssue,
  type NormalizeResult
} from './schema.js';
import { commitRelationshipImport, readImportRecord } from './service.js';

interface ValidateBody {
  payload?: unknown;
  raw_text?: unknown;
}

interface CommitBody {
  import_id?: unknown;
  mode?: unknown;
  character_id?: unknown;
  update_existing_character?: unknown;
  keep_uncertain_items?: unknown;
  payload?: unknown;
}

function fatalResponse(issues: ImportIssue[]) {
  return {
    valid: false,
    import_id: null,
    issues,
    preview: null,
    unknown_fields: []
  };
}

/**
 * Accepts either a parsed object or the raw pasted text. Raw text is preferred by
 * the client because it lets the server report the exact JSON syntax error instead
 * of a generic failure.
 */
function readPayload(body: ValidateBody): { ok: boolean; value: unknown; issue?: ImportIssue } {
  if (typeof body?.raw_text === 'string') {
    return parseRelationshipImportText(body.raw_text);
  }
  if (body?.payload === undefined) {
    return {
      ok: false,
      value: null,
      issue: {
        severity: 'FATAL',
        code: 'PAYLOAD_EMPTY',
        path: '',
        message: '导入内容为空，请粘贴整理后的 JSON 或上传 .json 文件。'
      }
    };
  }
  const serialized = JSON.stringify(body.payload) ?? '';
  if (Buffer.byteLength(serialized, 'utf8') > IMPORT_LIMITS.maxPayloadBytes) {
    return {
      ok: false,
      value: null,
      issue: {
        severity: 'FATAL',
        code: 'PAYLOAD_TOO_LARGE',
        path: '',
        message: `导入内容超过 ${IMPORT_LIMITS.maxPayloadBytes / 1024} KB 上限。`
      }
    };
  }
  return { ok: true, value: body.payload };
}

function previewOf(result: NormalizeResult) {
  const data = result.data;
  if (!data) return null;
  return {
    ...data,
    counts: {
      memories: data.memories.length,
      uncertain_items: data.uncertain_items.length,
      unfinished_threads: data.unfinished_threads.length,
      duplicate_memories: data.memories.filter((memory) => memory.duplicate_of).length
    }
  };
}

export function registerRelationshipImportRoutes(
  app: FastifyInstance,
  database: PomChatDatabase
) {
  app.get('/v1/relationship-imports/prompt-schema', async () => ({
    schema_version: RELATIONSHIP_IMPORT_SCHEMA_VERSION,
    limits: IMPORT_LIMITS
  }));

  // Validation is read-only for business data: it stores the payload as a pending
  // migration record and returns errors, warnings and a preview. Nothing lands in
  // agent_character / agent_relationship / agent_memory until commit.
  app.post<{ Body: ValidateBody }>(
    '/v1/relationship-imports/validate',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const parsed = readPayload(request.body ?? {});
      if (!parsed.ok) {
        reply.code(200);
        return fatalResponse(parsed.issue ? [parsed.issue] : []);
      }

      const result = normalizeRelationshipImport(parsed.value);
      if (!result.ok) {
        reply.code(200);
        return fatalResponse(result.issues);
      }

      const importId = randomUUID();
      await database.query(
        `INSERT INTO relationship_import (
           import_id, user_id, schema_version, source_platform,
           raw_payload, normalized_payload, status
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'VALIDATED')`,
        [
          importId,
          userId,
          RELATIONSHIP_IMPORT_SCHEMA_VERSION,
          result.data?.source_metadata.source_platform.slice(0, 80) || null,
          JSON.stringify(parsed.value),
          JSON.stringify(result.data)
        ]
      );

      return {
        valid: true,
        import_id: importId,
        issues: result.issues,
        preview: previewOf(result),
        unknown_fields: result.unknown_fields
      };
    }
  );

  // Commit re-validates the (possibly edited) payload server-side, checks ownership
  // of the target character, and performs every write in one transaction.
  app.post<{ Body: CommitBody }>(
    '/v1/relationship-imports/commit',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const body = request.body ?? {};
      const importId = typeof body.import_id === 'string' ? body.import_id : '';
      if (!importId) throw new AppError('VALIDATION_ERROR', '缺少迁移任务标识。');
      const record = await readImportRecord(database, userId, importId);

      const mode = body.mode === 'EXISTING' ? 'EXISTING' : 'CREATE';
      const characterId = typeof body.character_id === 'string' ? body.character_id : undefined;
      if (mode === 'EXISTING' && !characterId) {
        throw new AppError('VALIDATION_ERROR', '请选择要导入的已有角色。');
      }

      // The payload may have been edited in the preview step, so it goes through the
      // exact same validation as the original upload.
      const source = body.payload === undefined ? record.normalized_payload : body.payload;
      const candidate =
        source && typeof source === 'object' && !Array.isArray(source)
          ? { schema_version: RELATIONSHIP_IMPORT_SCHEMA_VERSION, ...(source as object) }
          : source;
      const result = normalizeRelationshipImport(candidate);
      if (!result.ok || !result.data) {
        throw new AppError(
          'RELATIONSHIP_IMPORT_INVALID',
          result.issues.find((issue) => issue.severity === 'FATAL')?.message
            ?? '迁移数据未通过校验。'
        );
      }

      const committed = await commitRelationshipImport(
        database,
        userId,
        importId,
        result.data,
        {
          mode,
          ...(characterId ? { characterId } : {}),
          updateExistingCharacter: body.update_existing_character === true
        },
        {
          keepUncertainItems: body.keep_uncertain_items !== false,
          rawPayload: candidate
        }
      );
      reply.code(committed.already_committed ? 200 : 201);
      return committed;
    }
  );

  // Listing intentionally omits raw and normalized payloads: relationship data is
  // never returned unless the caller opens one specific migration record.
  app.get('/v1/relationship-imports', async (request) => {
    const userId = await resolveUserId(request, database);
    const result = await database.query(
      `SELECT i.import_id, i.status, i.source_platform, i.memory_count,
              i.created_character, i.target_character_id, i.conversation_id,
              i.created_at, i.committed_at, c.name AS character_name
       FROM relationship_import i
       LEFT JOIN agent_character c ON c.character_id = i.target_character_id
       WHERE i.user_id = $1 AND i.deleted_at IS NULL
       ORDER BY i.created_at DESC
       LIMIT 50`,
      [userId]
    );
    return { imports: result.rows };
  });

  app.get<{ Params: { importId: string } }>(
    '/v1/relationship-imports/:importId',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const record = await readImportRecord(database, userId, request.params.importId);
      return {
        import_id: record.import_id,
        status: record.status,
        target_character_id: record.target_character_id,
        conversation_id: record.conversation_id,
        memory_count: record.memory_count,
        // Only the normalized view is returned; the raw payload stays server-side.
        payload: record.normalized_payload
      };
    }
  );

  // Deleting a migration record keeps the character, relationship and memories it
  // already wrote, unless the caller explicitly asks for them to go too.
  app.delete<{
    Params: { importId: string };
    Querystring: { delete_written_data?: string };
  }>('/v1/relationship-imports/:importId', async (request) => {
    const userId = await resolveUserId(request, database);
    const record = await readImportRecord(database, userId, request.params.importId);
    const deleteWrittenData = request.query.delete_written_data === 'true';
    let memoriesDeleted = 0;
    let characterDeleted = false;

    await database.transaction(async (transaction) => {
      if (deleteWrittenData && record.status === 'COMMITTED') {
        const memories = await transaction.query<{ memory_id: string }>(
          `UPDATE agent_memory
           SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE relationship_import_id = $1 AND user_id = $2 AND deleted_at IS NULL
           RETURNING memory_id`,
          [record.import_id, userId]
        );
        memoriesDeleted = memories.rows.length;
        // Only a character this migration created is removable this way; a
        // pre-existing character the user also chats with is left alone.
        if (record.created_character && record.target_character_id) {
          const character = await transaction.query<{ character_id: string }>(
            `UPDATE agent_character
             SET status = 'DELETED', deleted_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP, version = version + 1
             WHERE character_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
             RETURNING character_id`,
            [record.target_character_id, userId]
          );
          characterDeleted = character.rows.length > 0;
        }
      }
      await transaction.query(
        `UPDATE relationship_import
         SET deleted_at = CURRENT_TIMESTAMP,
             raw_payload = '{}'::jsonb,
             normalized_payload = '{}'::jsonb,
             status = CASE WHEN status = 'VALIDATED' THEN 'DISCARDED' ELSE status END
         WHERE import_id = $1 AND user_id = $2`,
        [record.import_id, userId]
      );
    });

    return {
      deleted: true,
      memories_deleted: memoriesDeleted,
      character_deleted: characterDeleted
    };
  });
}
