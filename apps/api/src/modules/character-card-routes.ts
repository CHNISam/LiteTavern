import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../lib/errors.js';
import { resolveUserId } from './identity.js';
import {
  exportCharacterCard,
  exportNormalizedCharacterCard,
  parseCharacterCard,
  validateNormalizedCharacterCard,
  type CharacterCardFormat,
  type CharacterCardPassthrough,
  type CharacterCardSourceMetadata,
  type NormalizedCharacterCard
} from './character-cards/adapter.js';
import type { CharacterAssetStore } from './character-assets.js';
import { validateAvatarUpload } from './avatar-image.js';

type StoredCharacterCardFormat = CharacterCardFormat | 'INTERNAL';

interface CardUpload {
  file: Buffer;
  fileName: string;
  mediaType: string;
  replaceCharacterId?: string;
}

interface StoredCard {
  card_version_id: string;
  version_no: number;
  source_format: StoredCharacterCardFormat;
  source_spec_version: string | null;
  raw_object_key: string | null;
  normalized_data: unknown;
  passthrough_data: CharacterCardPassthrough | null;
  source_metadata: CharacterCardSourceMetadata | null;
  preserved_data: Record<string, unknown> | null;
  warning_json: string[] | null;
}

const EMPTY_PASSTHROUGH: CharacterCardPassthrough = { root: {}, data: {} };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function readCardUpload(request: FastifyRequest): Promise<CardUpload> {
  let file: Buffer | undefined;
  let fileName = 'character-card';
  let mediaType = 'application/octet-stream';
  let replaceCharacterId: string | undefined;
  for await (const part of request.parts()) {
    if (part.type === 'file' && part.fieldname === 'file') {
      file = await part.toBuffer();
      fileName = part.filename || fileName;
      mediaType = part.mimetype || mediaType;
    }
    if (part.type === 'field' && part.fieldname === 'replace_character_id') {
      replaceCharacterId = String(part.value);
    }
  }
  if (!file) throw new AppError('VALIDATION_ERROR', '请选择角色卡文件。');
  return { file, fileName, mediaType, ...(replaceCharacterId ? { replaceCharacterId } : {}) };
}

function parseSafely(file: Buffer) {
  try {
    return parseCharacterCard(file);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'CHARACTER_CARD_INVALID';
    if (code === 'CHARACTER_CARD_TOO_LARGE') {
      throw new AppError('CHARACTER_CARD_INVALID', '角色卡不能超过 10 MB。', 413);
    }
    if (code === 'CHARACTER_CARD_FORMAT_UNSUPPORTED') {
      throw new AppError(
        'CHARACTER_CARD_INVALID',
        '已识别为尚未支持的角色卡封装（例如 CHARX）；本次未创建角色，也未执行其中内容。',
        400
      );
    }
    throw new AppError(
      'CHARACTER_CARD_INVALID',
      '无法根据文件内容识别或解析这个角色卡；请检查数据结构和字段类型。',
      400
    );
  }
}

function validateNormalizedSafely(value: unknown): NormalizedCharacterCard {
  try {
    return validateNormalizedCharacterCard(value);
  } catch {
    throw new AppError(
      'VALIDATION_ERROR',
      '角色名称不能为空，且角色字段必须使用正确的文本或列表类型。'
    );
  }
}

function compatibilityResponse(metadata: CharacterCardSourceMetadata) {
  return {
    level: metadata.compatibility_level,
    unapplied_fields: metadata.unapplied_fields
  };
}

function internalMetadata(): CharacterCardSourceMetadata {
  return {
    format: 'INTERNAL',
    container: 'INTERNAL',
    spec_version: 'pomchat-0.1.0',
    compatibility_level: 'FORMAL',
    parser_id: 'pomchat/internal-character',
    parser_version: '0.2.0',
    unapplied_fields: []
  };
}

function legacyNormalized(value: unknown): NormalizedCharacterCard {
  try {
    return validateNormalizedCharacterCard(value);
  } catch {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return validateNormalizedCharacterCard({
      name: typeof record.name === 'string' ? record.name : '',
      description: typeof record.description === 'string' ? record.description : '',
      personality: typeof record.personality === 'string' ? record.personality : '',
      scenario: typeof record.scenario === 'string' ? record.scenario : '',
      first_message: typeof record.first_message === 'string'
        ? record.first_message
        : typeof record.firstMessage === 'string' ? record.firstMessage : '',
      alternate_greetings: Array.isArray(record.alternate_greetings)
        ? record.alternate_greetings
        : [],
      example_messages: typeof record.example_messages === 'string' ? record.example_messages : '',
      system_prompt: typeof record.system_prompt === 'string' ? record.system_prompt : '',
      post_history_instructions: typeof record.post_history_instructions === 'string'
        ? record.post_history_instructions
        : '',
      tags: Array.isArray(record.tags) ? record.tags : [],
      creator: record.creator && typeof record.creator === 'object' && !Array.isArray(record.creator)
        ? record.creator
        : { name: '', notes: '', character_version: '' }
    });
  }
}

function restoreLegacyPassthrough(card: StoredCard): CharacterCardPassthrough {
  if (
    card.passthrough_data
    && (
      Object.keys(card.passthrough_data.root ?? {}).length
      || Object.keys(card.passthrough_data.data ?? {}).length
      || card.source_metadata?.parser_id
    )
  ) return card.passthrough_data;
  if (!card.preserved_data || card.source_format === 'INTERNAL') return EMPTY_PASSTHROUGH;
  try {
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(card.preserved_data), 'utf8'));
    return parsed.passthroughData;
  } catch {
    return EMPTY_PASSTHROUGH;
  }
}

async function insertCharacter(
  database: PomChatDatabase,
  input: {
    userId: string;
    characterId: string;
    cardVersionId: string;
    sourceFormat: StoredCharacterCardFormat;
    specVersion: string;
    rawObjectKey: string | null;
    checksum: string | null;
    normalized: NormalizedCharacterCard;
    passthrough: CharacterCardPassthrough;
    metadata: CharacterCardSourceMetadata;
    preserved: Record<string, unknown>;
    warnings: string[];
  }
): Promise<void> {
  await database.exec('BEGIN');
  try {
    await database.query(
      `INSERT INTO agent_character (
         character_id, owner_user_id, visibility, name, profile_summary,
         personality_summary, first_message, avatar_seed, status
       ) VALUES ($1, $2, 'PRIVATE', $3, $4, $5, $6, $7, 'ACTIVE')`,
      [
        input.characterId,
        input.userId,
        input.normalized.name,
        input.normalized.description,
        input.normalized.personality,
        input.normalized.first_message,
        input.normalized.name
      ]
    );
    await database.query(
      `INSERT INTO agent_character_card_version (
         card_version_id, character_id, version_no, source_format,
         source_spec_version, import_status, raw_object_key, checksum_sha256,
         normalized_data, passthrough_data, source_metadata, preserved_data,
         parser_version, warning_json
       ) VALUES (
         $1, $2, 1, $3, $4, 'READY', $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb
       )`,
      [
        input.cardVersionId,
        input.characterId,
        input.sourceFormat,
        input.specVersion,
        input.rawObjectKey,
        input.checksum,
        JSON.stringify(input.normalized),
        JSON.stringify(input.passthrough),
        JSON.stringify(input.metadata),
        JSON.stringify(input.preserved),
        input.metadata.parser_version,
        JSON.stringify(input.warnings)
      ]
    );
    await database.query(
      `UPDATE agent_character
       SET active_card_version_id = $2, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE character_id = $1`,
      [input.characterId, input.cardVersionId]
    );
    await database.exec('COMMIT');
  } catch (error) {
    await database.exec('ROLLBACK');
    throw error;
  }
}

async function readOwnedCard(
  database: PomChatDatabase,
  userId: string,
  characterId: string
): Promise<(StoredCard & { name: string; avatar_object_key: string | null }) | null> {
  const result = await database.query<StoredCard & {
    name: string;
    avatar_object_key: string | null;
  }>(
    `SELECT c.name, c.avatar_object_key,
            v.card_version_id, v.version_no, v.source_format, v.source_spec_version,
            v.raw_object_key, v.normalized_data, v.passthrough_data,
            v.source_metadata, v.preserved_data, v.warning_json
     FROM agent_character c
     JOIN agent_character_card_version v ON v.card_version_id = c.active_card_version_id
     WHERE c.character_id = $1 AND c.owner_user_id = $2 AND c.deleted_at IS NULL
       AND v.import_status = 'READY'`,
    [characterId, userId]
  );
  return result.rows[0] ?? null;
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
    const checksum = createHash('sha256').update(upload.file).digest('hex');
    const sourceMetadata = {
      ...parsed.sourceMetadata,
      file_name: upload.fileName,
      media_type: upload.mediaType,
      file_size: upload.file.length,
      checksum_sha256: checksum
    };
    return {
      format: parsed.format,
      spec_version: parsed.specVersion,
      character: parsed.character,
      normalized_data: parsed.normalizedData,
      source_metadata: sourceMetadata,
      compatibility: compatibilityResponse(sourceMetadata),
      warnings: parsed.warnings
    };
  });

  app.post('/v1/characters/import', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const upload = await readCardUpload(request);
    const parsed = parseSafely(upload.file);
    const checksum = createHash('sha256').update(upload.file).digest('hex');
    const metadata: CharacterCardSourceMetadata = {
      ...parsed.sourceMetadata,
      file_name: upload.fileName,
      media_type: upload.mediaType,
      file_size: upload.file.length,
      checksum_sha256: checksum
    };
    const cardVersionId = randomUUID();
    const rawObjectKey = parsed.format.endsWith('_PNG')
      ? await assetStore.put(`${cardVersionId}.png`, upload.file)
      : null;

    if (!upload.replaceCharacterId) {
      const characterId = randomUUID();
      await insertCharacter(database, {
        userId,
        characterId,
        cardVersionId,
        sourceFormat: parsed.format,
        specVersion: parsed.specVersion,
        rawObjectKey,
        checksum,
        normalized: parsed.normalizedData,
        passthrough: parsed.passthroughData,
        metadata,
        preserved: parsed.source,
        warnings: parsed.warnings
      });
      reply.code(201);
      return {
        character_id: characterId,
        card_version_id: cardVersionId,
        status: 'READY',
        compatibility: compatibilityResponse(metadata)
      };
    }

    const current = await readOwnedCard(database, userId, upload.replaceCharacterId);
    if (!current) throw new AppError('RESOURCE_NOT_FOUND', '要替换的角色不存在。', 404);
    const characterId = upload.replaceCharacterId;
    await database.exec('BEGIN');
    try {
      await database.query(
        `INSERT INTO agent_character_card_version (
           card_version_id, character_id, version_no, source_format,
           source_spec_version, import_status, raw_object_key, checksum_sha256,
           normalized_data, passthrough_data, source_metadata, preserved_data,
           parser_version, warning_json
         ) VALUES (
           $1, $2, $3, $4, $5, 'READY', $6, $7,
           $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb
         )`,
        [
          cardVersionId,
          characterId,
          current.version_no + 1,
          parsed.format,
          parsed.specVersion,
          rawObjectKey,
          checksum,
          JSON.stringify(parsed.normalizedData),
          JSON.stringify(parsed.passthroughData),
          JSON.stringify(metadata),
          JSON.stringify(parsed.source),
          metadata.parser_version,
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
          parsed.normalizedData.name,
          parsed.normalizedData.description,
          parsed.normalizedData.personality,
          parsed.normalizedData.first_message
        ]
      );
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
    reply.code(201);
    return {
      character_id: characterId,
      card_version_id: cardVersionId,
      status: 'READY',
      compatibility: compatibilityResponse(metadata)
    };
  });

  app.post<{ Body: unknown }>('/v1/characters', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const normalized = validateNormalizedSafely(request.body);
    const characterId = randomUUID();
    const cardVersionId = randomUUID();
    const metadata = internalMetadata();
    await insertCharacter(database, {
      userId,
      characterId,
      cardVersionId,
      sourceFormat: 'INTERNAL',
      specVersion: metadata.spec_version,
      rawObjectKey: null,
      checksum: null,
      normalized,
      passthrough: EMPTY_PASSTHROUGH,
      metadata,
      preserved: {},
      warnings: []
    });
    reply.code(201);
    return { character_id: characterId, card_version_id: cardVersionId, status: 'READY' };
  });

  app.get<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId/card',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const card = await readOwnedCard(database, userId, request.params.characterId);
      if (!card) throw new AppError('RESOURCE_NOT_FOUND', '角色卡不存在。', 404);
      const normalized = legacyNormalized(card.normalized_data);
      const metadata: CharacterCardSourceMetadata = card.source_metadata?.parser_id
        ? card.source_metadata
        : {
            ...internalMetadata(),
            format: card.source_format === 'INTERNAL' ? 'INTERNAL' : 'CHARACTER_CARD_V2',
            container: card.source_format.endsWith('_PNG') ? 'PNG' : 'JSON',
            spec_version: card.source_spec_version ?? '',
            compatibility_level: 'COMPATIBLE' as const,
            unapplied_fields: []
          };
      return {
        character_id: request.params.characterId,
        normalized_data: normalized,
        source_metadata: metadata,
        compatibility: compatibilityResponse(metadata),
        warnings: card.warning_json ?? []
      };
    }
  );

  app.put<{ Params: { characterId: string }; Body: unknown }>(
    '/v1/characters/:characterId/card',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const normalized = validateNormalizedSafely(request.body);
      const current = await readOwnedCard(database, userId, request.params.characterId);
      if (!current) throw new AppError('RESOURCE_NOT_FOUND', '角色卡不存在。', 404);
      const cardVersionId = randomUUID();
      const passthrough = restoreLegacyPassthrough(current);
      const metadata = current.source_metadata?.parser_id
        ? current.source_metadata
        : internalMetadata();
      await database.exec('BEGIN');
      try {
        await database.query(
          `INSERT INTO agent_character_card_version (
             card_version_id, character_id, version_no, source_format,
             source_spec_version, import_status, raw_object_key, checksum_sha256,
             normalized_data, passthrough_data, source_metadata, preserved_data,
             parser_version, warning_json
           ) VALUES (
             $1, $2, $3, $4, $5, 'READY', $6, NULL,
             $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb
           )`,
          [
            cardVersionId,
            request.params.characterId,
            current.version_no + 1,
            current.source_format,
            current.source_spec_version,
            current.raw_object_key,
            JSON.stringify(normalized),
            JSON.stringify(passthrough),
            JSON.stringify(metadata),
            JSON.stringify(current.preserved_data ?? {}),
            metadata.parser_version,
            JSON.stringify(current.warning_json ?? [])
          ]
        );
        await database.query(
          `UPDATE agent_character
           SET active_card_version_id = $2, name = $3, profile_summary = $4,
               personality_summary = $5, first_message = $6,
               version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE character_id = $1`,
          [
            request.params.characterId,
            cardVersionId,
            normalized.name,
            normalized.description,
            normalized.personality,
            normalized.first_message
          ]
        );
        await database.exec('COMMIT');
      } catch (error) {
        await database.exec('ROLLBACK');
        throw error;
      }
      return {
        character_id: request.params.characterId,
        card_version_id: cardVersionId,
        status: 'READY'
      };
    }
  );

  app.post<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId/avatar',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const card = await readOwnedCard(database, userId, request.params.characterId);
      if (!card) throw new AppError('RESOURCE_NOT_FOUND', '角色不存在。', 404);
      const upload = await readCardUpload(request);
      let detected;
      try {
        detected = validateAvatarUpload(upload.file);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'AVATAR_INVALID';
        if (code === 'AVATAR_TOO_LARGE') {
          throw new AppError('VALIDATION_ERROR', '处理后的头像不能超过 2 MB。', 413);
        }
        if (code === 'AVATAR_DIMENSIONS_TOO_LARGE') {
          throw new AppError(
            'VALIDATION_ERROR',
            '头像尺寸过大，请在裁剪界面缩放后再上传（最长边不超过 1024 像素）。'
          );
        }
        throw new AppError('VALIDATION_ERROR', '无法解析图片，请选择有效的 PNG、JPEG 或 WebP 文件。');
      }
      const key = await assetStore.put(
        `${request.params.characterId}-${randomUUID()}.${detected.extension}`,
        upload.file
      );
      await database.query(
        `UPDATE agent_character
         SET avatar_object_key = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE character_id = $1`,
        [request.params.characterId, key]
      );
      return { avatar_updated: true };
    }
  );

  app.delete<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId/avatar',
    async (request) => {
      const userId = await resolveUserId(request, database);
      const result = await database.query<{ character_id: string }>(
        `UPDATE agent_character
         SET avatar_object_key = '', version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE character_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
         RETURNING character_id`,
        [request.params.characterId, userId]
      );
      if (!result.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '角色不存在。', 404);
      return { avatar_removed: true };
    }
  );

  app.get<{ Params: { characterId: string } }>(
    '/v1/characters/:characterId/avatar',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const result = await database.query<{
        avatar_object_key: string | null;
        raw_object_key: string | null;
      }>(
        `SELECT c.avatar_object_key, v.raw_object_key
         FROM agent_character c
         JOIN agent_character_card_version v ON v.card_version_id = c.active_card_version_id
         WHERE c.character_id = $1 AND c.status = 'ACTIVE'
           AND (c.visibility = 'PLATFORM' OR c.owner_user_id = $2)`,
        [request.params.characterId, userId]
      );
      const row = result.rows[0];
      const key = row?.avatar_object_key ?? row?.raw_object_key;
      if (!key) throw new AppError('RESOURCE_NOT_FOUND', '角色头像不存在。', 404);
      const image = await assetStore.get(key);
      if (!image) throw new AppError('RESOURCE_NOT_FOUND', '角色头像不存在。', 404);
      let detected;
      try {
        detected = validateAvatarUpload(image);
      } catch {
        throw new AppError('RESOURCE_NOT_FOUND', '角色头像格式无效。', 404);
      }
      return reply
        .type(detected.mediaType)
        .header('Cache-Control', 'private, max-age=3600')
        .send(image);
    }
  );

  app.get<{
    Params: { characterId: string };
    Querystring: { format?: CharacterCardFormat };
  }>('/v1/characters/:characterId/export', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const card = await readOwnedCard(database, userId, request.params.characterId);
    if (!card) throw new AppError('RESOURCE_NOT_FOUND', '角色卡不存在。', 404);
    const format = request.query.format
      ?? (card.source_format === 'INTERNAL' ? 'CCV3_JSON' : card.source_format);
    const supported: CharacterCardFormat[] = [
      'CCV1_JSON', 'CCV1_PNG',
      'CCV2_JSON', 'CCV2_PNG',
      'CCV3_JSON', 'CCV3_PNG'
    ];
    if (!supported.includes(format)) {
      throw new AppError('VALIDATION_ERROR', '不支持的导出格式。');
    }
    let basePng: Buffer | undefined;
    if (format.endsWith('_PNG')) {
      const original = card.raw_object_key ? await assetStore.get(card.raw_object_key) : null;
      const avatar = card.avatar_object_key ? await assetStore.get(card.avatar_object_key) : null;
      const candidate = original?.subarray(0, 8).equals(PNG_SIGNATURE)
        ? original
        : avatar?.subarray(0, 8).equals(PNG_SIGNATURE) ? avatar : null;
      if (candidate) basePng = candidate;
    }
    const output = exportNormalizedCharacterCard(
      legacyNormalized(card.normalized_data),
      restoreLegacyPassthrough(card),
      format,
      basePng ? { basePng } : {}
    );
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

// Kept as an explicit export for migration/debug tooling that needs to serialize
// a raw preserved document without normalizing it first.
export { exportCharacterCard };
