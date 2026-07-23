import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../lib/errors.js';
import { resolveUserId } from './identity.js';
import {
  exportCharacterCard,
  parseCharacterCard,
  type CharacterCardFormat
} from './character-cards/adapter.js';
import type { CharacterAssetStore } from './character-assets.js';

async function readCardUpload(request: FastifyRequest): Promise<{
  file: Buffer;
  replaceCharacterId?: string;
}> {
  let file: Buffer | undefined;
  let replaceCharacterId: string | undefined;
  for await (const part of request.parts()) {
    if (part.type === 'file' && part.fieldname === 'file') file = await part.toBuffer();
    if (part.type === 'field' && part.fieldname === 'replace_character_id') {
      replaceCharacterId = String(part.value);
    }
  }
  if (!file) throw new AppError('VALIDATION_ERROR', '请选择角色卡文件。');
  return { file, ...(replaceCharacterId ? { replaceCharacterId } : {}) };
}

function parseSafely(file: Buffer) {
  try {
    return parseCharacterCard(file);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'CHARACTER_CARD_INVALID';
    if (code === 'CHARACTER_CARD_TOO_LARGE') {
      throw new AppError('CHARACTER_CARD_INVALID', '角色卡不能超过 10 MB。', 413);
    }
    throw new AppError('CHARACTER_CARD_INVALID', '无法识别或解析这个角色卡。', 400);
  }
}

export function registerCharacterCardRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  assetStore: CharacterAssetStore
) {
  app.post('/v1/characters/import/preview', async (request) => {
    await resolveUserId(request, database);
    const upload = await readCardUpload(request);
    const parsed = parseSafely(upload.file);
    return {
      format: parsed.format,
      spec_version: parsed.specVersion,
      character: parsed.character,
      warnings: parsed.warnings
    };
  });

  app.post('/v1/characters/import', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const upload = await readCardUpload(request);
    const parsed = parseSafely(upload.file);
    const cardVersionId = randomUUID();
    const rawObjectKey = parsed.format.endsWith('_PNG')
      ? await assetStore.put(`${cardVersionId}.png`, upload.file)
      : null;
    let characterId = upload.replaceCharacterId;
    let versionNo = 1;

    if (characterId) {
      const owned = await database.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(v.version_no), 0)::int + 1 AS next_version
         FROM agent_character c
         LEFT JOIN agent_character_card_version v ON v.character_id = c.character_id
         WHERE c.character_id = $1 AND c.owner_user_id = $2 AND c.deleted_at IS NULL
         GROUP BY c.character_id`,
        [characterId, userId]
      );
      if (!owned.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '要替换的角色不存在。', 404);
      versionNo = owned.rows[0].next_version;
    } else {
      characterId = randomUUID();
    }

    await database.exec('BEGIN');
    try {
      if (versionNo === 1) {
        await database.query(
          `INSERT INTO agent_character (
             character_id, owner_user_id, visibility, name, profile_summary,
             personality_summary, first_message, avatar_seed, status
           ) VALUES ($1, $2, 'PRIVATE', $3, $4, $5, $6, $7, 'ACTIVE')`,
          [
            characterId,
            userId,
            parsed.character.name,
            parsed.character.description,
            parsed.character.personality,
            parsed.character.firstMessage,
            parsed.character.name
          ]
        );
      }
      await database.query(
        `INSERT INTO agent_character_card_version (
           card_version_id, character_id, version_no, source_format,
           source_spec_version, import_status, raw_object_key, checksum_sha256,
           normalized_data, preserved_data, parser_version, warning_json
         ) VALUES ($1, $2, $3, $4, $5, 'READY', $6, $7, $8::jsonb, $9::jsonb,
                   'pomchat-card-adapter-0.1.0', $10::jsonb)`,
        [
          cardVersionId,
          characterId,
          versionNo,
          parsed.format,
          parsed.specVersion,
          rawObjectKey,
          createHash('sha256').update(upload.file).digest('hex'),
          JSON.stringify(parsed.character),
          JSON.stringify(parsed.preserved),
          JSON.stringify(parsed.warnings)
        ]
      );
      await database.query(
        `UPDATE agent_character
         SET active_card_version_id = $2, name = $3, profile_summary = $4,
             personality_summary = $5, first_message = $6,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE character_id = $1`,
        [
          characterId,
          cardVersionId,
          parsed.character.name,
          parsed.character.description,
          parsed.character.personality,
          parsed.character.firstMessage
        ]
      );
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
    reply.code(201);
    return { character_id: characterId, card_version_id: cardVersionId, status: 'READY' };
  });

  app.get<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId/avatar',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const result = await database.query<{ raw_object_key: string | null }>(
        `SELECT v.raw_object_key
         FROM agent_character c
         JOIN agent_character_card_version v ON v.card_version_id = c.active_card_version_id
         WHERE c.character_id = $1 AND c.status = 'ACTIVE'
           AND (c.visibility = 'PLATFORM' OR c.owner_user_id = $2)`,
        [request.params.characterId, userId]
      );
      const key = result.rows[0]?.raw_object_key;
      if (!key) throw new AppError('RESOURCE_NOT_FOUND', '角色头像不存在。', 404);
      const image = await assetStore.get(key);
      if (!image) throw new AppError('RESOURCE_NOT_FOUND', '角色头像不存在。', 404);
      return reply.type('image/png').header('Cache-Control', 'private, max-age=3600').send(image);
    }
  );

  app.get<{
    Params: { characterId: string };
    Querystring: { format?: CharacterCardFormat };
  }>('/v1/characters/:characterId/export', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const result = await database.query<{
      name: string;
      source_format: CharacterCardFormat;
      raw_object_key: string | null;
      preserved_data: Record<string, unknown>;
    }>(
      `SELECT c.name, v.source_format, v.raw_object_key, v.preserved_data
       FROM agent_character c
       JOIN agent_character_card_version v ON v.card_version_id = c.active_card_version_id
       WHERE c.character_id = $1 AND c.owner_user_id = $2 AND c.deleted_at IS NULL
         AND v.import_status = 'READY'`,
      [request.params.characterId, userId]
    );
    const card = result.rows[0];
    if (!card) throw new AppError('RESOURCE_NOT_FOUND', '角色卡不存在。', 404);
    const format = request.query.format ?? card.source_format;
    if (!['CCV2_JSON', 'CCV2_PNG', 'CCV3_JSON', 'CCV3_PNG'].includes(format)) {
      throw new AppError('VALIDATION_ERROR', '不支持的导出格式。');
    }
    const version = format.startsWith('CCV3') ? 3 : 2;
    const source = structuredClone(card.preserved_data);
    source.spec = `chara_card_v${version}`;
    source.spec_version = `${version}.0`;
    const original =
      format === card.source_format && format.endsWith('_PNG') && card.raw_object_key
        ? await assetStore.get(card.raw_object_key)
        : null;
    const output = original ?? exportCharacterCard(source, format);
    const extension = format.endsWith('PNG') ? 'png' : 'json';
    reply
      .type(extension === 'png' ? 'image/png' : 'application/json; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="pomchat-character-${request.params.characterId}.${extension}"`
      );
    return reply.send(output);
  });
}
