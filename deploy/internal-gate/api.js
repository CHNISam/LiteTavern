import {
  importPayloadFromPreview,
  validateRelationshipImportText
} from './relationship-import.js';

const COOKIE_NAME = 'litetavern_anon';
const MAX_CARD_BYTES = 10 * 1024 * 1024;
const MAX_RELATIONSHIP_IMPORT_BYTES = 1024 * 1024;
const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow'
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function error(code, message, status, retryable = false) {
  return json({ error: { code, message, retryable } }, status);
}

function parseCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function identityPayload(user) {
  return {
    user: {
      user_id: user.user_id,
      anonymous_id: user.anonymous_id,
      identity_type: 'ANONYMOUS',
      email: null,
      registered: false,
      free_quota_total: 0,
      free_quota_remaining: 0,
      free_quota_available: 0,
      free_quota_enabled: false
    }
  };
}

async function requireIdentity(request, repository) {
  const token = parseCookie(request, COOKIE_NAME);
  if (!token) return null;
  return repository.findIdentity(await tokenHash(token));
}

function assertSameOrigin(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiFault('ORIGIN_NOT_ALLOWED', '请求来源不受信任。', 403);
  }
}

class ApiFault extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function normalizeCharacter(value) {
  const source = value && typeof value === 'object' ? value : {};
  const creator = source.creator && typeof source.creator === 'object'
    ? source.creator
    : {};
  const normalized = {
    name: string(source.name).trim(),
    description: string(source.description),
    personality: string(source.personality),
    scenario: string(source.scenario),
    first_message: string(source.first_message ?? source.first_mes),
    alternate_greetings: strings(source.alternate_greetings),
    example_messages: string(source.example_messages ?? source.mes_example),
    system_prompt: string(source.system_prompt),
    post_history_instructions: string(source.post_history_instructions),
    tags: strings(source.tags),
    creator: {
      name: string(creator.name ?? source.creator),
      notes: string(creator.notes ?? source.creator_notes),
      character_version: string(
        creator.character_version ?? source.character_version
      )
    }
  };
  if (!normalized.name) {
    throw new ApiFault('INVALID_CHARACTER', '角色名称不能为空。', 400);
  }
  return normalized;
}

function base64Bytes(value) {
  const binary = atob(value.replace(/\s+/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function embeddedPngCard(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder('latin1').decode(
      bytes.subarray(offset + 4, offset + 8)
    );
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) break;
    if (type === 'tEXt') {
      const chunk = bytes.subarray(offset + 8, end);
      const separator = chunk.indexOf(0);
      if (separator > 0) {
        const keyword = new TextDecoder('latin1').decode(chunk.subarray(0, separator));
        if (keyword === 'chara' || keyword === 'ccv3') {
          const encoded = new TextDecoder('latin1').decode(
            chunk.subarray(separator + 1)
          );
          return new TextDecoder().decode(base64Bytes(encoded));
        }
      }
    }
    offset = end + 4;
  }
  return null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiFault('INVALID_CHARACTER_CARD', '无法识别角色卡内容。', 400);
  }
}

export function parseCharacterCard(input, fileName = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CARD_BYTES) {
    throw new ApiFault(
      'INVALID_CHARACTER_CARD',
      bytes.byteLength > MAX_CARD_BYTES
        ? '角色卡不能超过 10 MB。'
        : '无法识别空的角色卡文件。',
      400
    );
  }

  let pngText;
  try {
    pngText = embeddedPngCard(bytes);
  } catch {
    throw new ApiFault(
      'INVALID_CHARACTER_CARD',
      '无法识别角色卡内容。',
      400
    );
  }
  const container = pngText === null ? 'JSON' : 'PNG';
  const decoded = pngText ?? new TextDecoder().decode(bytes);
  const card = parseJson(decoded);
  const data = card?.data && typeof card.data === 'object' ? card.data : card;
  const normalized = normalizeCharacter(data);
  const spec = string(card?.spec);
  const format = spec === 'chara_card_v3'
    ? 'Character Card V3'
    : spec === 'chara_card_v2'
      ? 'Character Card V2'
      : card?.data
        ? 'Character Card'
        : 'Tavern Card V1';
  const known = new Set([
    'name', 'description', 'personality', 'scenario', 'first_mes',
    'first_message', 'alternate_greetings', 'mes_example', 'example_messages',
    'system_prompt', 'post_history_instructions', 'tags', 'creator',
    'creator_notes', 'character_version'
  ]);
  const unapplied = Object.keys(data ?? {}).filter((key) => !known.has(key));
  const compatibility = unapplied.length > 0 ? 'COMPATIBLE' : 'FORMAL';
  const sourceMetadata = {
    compatibility_level: compatibility,
    format,
    container,
    file_name: fileName,
    spec_version: string(card?.spec_version),
    unapplied_fields: unapplied
  };
  return {
    format,
    spec_version: string(card?.spec_version),
    character: {
      name: normalized.name,
      description: normalized.description,
      personality: normalized.personality,
      firstMessage: normalized.first_message
    },
    normalized_data: normalized,
    source_metadata: sourceMetadata,
    compatibility: {
      level: compatibility,
      unapplied_fields: unapplied
    },
    warnings: unapplied.length > 0
      ? ['部分扩展字段已原样保留，但不会参与当前版本的对话。']
      : [],
    source_card: card,
    content_type: container === 'PNG' ? 'image/png' : 'application/json'
  };
}

async function uploadedCard(request) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new ApiFault('FILE_REQUIRED', '请选择角色卡文件。', 400);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes,
    parsed: parseCharacterCard(bytes, file.name ?? '')
  };
}

function createRecord(normalized, sourceMetadata, sourceCard = null) {
  return {
    character_id: crypto.randomUUID(),
    normalized_data: normalized,
    source_metadata: sourceMetadata,
    source_card: sourceCard,
    warnings: sourceMetadata.unapplied_fields.length > 0
      ? ['部分扩展字段已原样保留，但不会参与当前版本的对话。']
      : [],
    version: 1,
    raw_object_key: null,
    avatar_object_key: null
  };
}

function publicCardDetail(character) {
  return {
    normalized_data: character.normalized_data,
    source_metadata: character.source_metadata,
    warnings: character.warnings ?? []
  };
}

function cloudStatus() {
  return {
    cloud: {
      stage: 'ALPHA',
      identity_type: 'ANONYMOUS',
      registered: false,
      platform_models_available: false,
      free_quota_enabled: false,
      free_quota_total: 0,
      free_quota_remaining: 0,
      free_quota_available: 0,
      quota: {
        source: 'NONE',
        total: 0,
        used: 0,
        available: 0,
        remaining_ratio: 0,
        cycle_ends_at: null
      },
      next_actions: ['USE_BYOK'],
      support: { enabled: false }
    }
  };
}

export async function handleApiRequest(request, { repository, objects }) {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/v1/identities/anonymous') {
      const currentToken = parseCookie(request, COOKIE_NAME);
      if (currentToken) {
        const existing = await repository.findIdentity(await tokenHash(currentToken));
        if (existing) return json(identityPayload(existing));
      }
      const token = randomToken();
      const user = await repository.createIdentity(await tokenHash(token));
      return json(identityPayload(user), 200, {
        'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`
      });
    }

    const user = await requireIdentity(request, repository);
    if (!user) {
      return error('UNAUTHENTICATED', '请先初始化匿名身份。', 401);
    }

    if (request.method === 'GET' && path === '/v1/cloud/status') {
      return json(cloudStatus());
    }
    if (request.method === 'POST' && path === '/v1/cloud/sync/checkpoint') {
      return json({ sync: {} });
    }
    if (request.method === 'POST' && path === '/v1/analytics/events') {
      const body = await request.json().catch(() => ({}));
      const count = Array.isArray(body.events) ? body.events.length : 0;
      return json({ accepted: count, duplicates: 0 }, 202);
    }
    if (request.method === 'GET' && path === '/v1/model-configurations') {
      return json({ configurations: [] });
    }
    if (request.method === 'GET' && path === '/v1/providers') {
      return json({ providers: [] });
    }

    if (request.method === 'POST' && path === '/v1/relationship-imports/validate') {
      const body = await request.json().catch(() => ({}));
      const rawText = string(body.raw_text);
      if (!rawText || new TextEncoder().encode(rawText).byteLength > MAX_RELATIONSHIP_IMPORT_BYTES) {
        throw new ApiFault(
          'RELATIONSHIP_IMPORT_SIZE_INVALID',
          '迁移 JSON 不能为空且不能超过 1 MB。',
          400
        );
      }
      const validation = validateRelationshipImportText(rawText);
      if (!validation.valid || !validation.preview) {
        return json({ ...validation, preview: null, import_id: null });
      }
      const importId = crypto.randomUUID();
      await repository.createRelationshipImport(
        user.user_id,
        importId,
        importPayloadFromPreview(validation.preview)
      );
      return json({ ...validation, import_id: importId });
    }

    if (request.method === 'POST' && path === '/v1/relationship-imports/commit') {
      const body = await request.json().catch(() => ({}));
      const importId = string(body.import_id);
      const staged = await repository.getRelationshipImport(user.user_id, importId);
      if (!staged) return error('RELATIONSHIP_IMPORT_NOT_FOUND', '迁移记录不存在或已失效。', 404);
      if (staged.status === 'COMMITTED' && staged.result) {
        return json({ ...staged.result, already_committed: true });
      }

      const validation = validateRelationshipImportText(JSON.stringify(body.payload ?? null));
      if (!validation.valid || !validation.preview) {
        return json({
          valid: false,
          import_id: null,
          preview: null,
          unknown_fields: validation.unknown_fields,
          issues: validation.issues
        }, 400);
      }
      const payload = importPayloadFromPreview(validation.preview);
      if (body.keep_uncertain_items === false) payload.uncertain_items = [];
      const mode = body.mode === 'EXISTING' ? 'EXISTING' : 'CREATE';
      let character;
      let createdCharacter = false;

      if (mode === 'EXISTING') {
        character = await repository.getCharacter(user.user_id, string(body.character_id));
        if (!character) return error('NOT_FOUND', '目标角色不存在。', 404);
      } else {
        if (!payload.character.name) {
          throw new ApiFault(
            'RELATIONSHIP_IMPORT_CHARACTER_REQUIRED',
            '创建新角色前需要补充角色名称。',
            400
          );
        }
        const normalized = normalizeCharacter({
          name: payload.character.name,
          description: payload.character.description,
          personality: payload.character.personality_traits.join('、'),
          scenario: payload.relationship.summary,
          first_message: '关系资料已迁移完成，我们可以从这里继续。',
          alternate_greetings: [],
          example_messages: '',
          system_prompt: '',
          post_history_instructions: '',
          tags: [],
          creator: { name: '', notes: '', character_version: '' }
        });
        character = createRecord(normalized, {
          compatibility_level: 'FORMAL',
          format: 'LiteTavern Relationship Import',
          container: 'JSON',
          unapplied_fields: []
        });
        await repository.createCharacter(user.user_id, character);
        createdCharacter = true;
      }

      try {
        const conversationId = await repository.getOrCreateConversation(user.user_id, character);
        const processedAt = new Date().toISOString();
        payload.source_metadata.processed_at = processedAt;
        const result = await repository.commitRelationshipImport(
          user.user_id,
          importId,
          character.character_id,
          conversationId,
          payload,
          processedAt,
          createdCharacter
        );
        if (mode === 'EXISTING' && body.update_existing_character === true) {
          await repository.updateCharacter(user.user_id, character.character_id, {
            normalized_data: {
              ...character.normalized_data,
              name: payload.character.name || character.normalized_data.name,
              description: payload.character.description,
              personality: payload.character.personality_traits.join('、'),
              scenario: payload.relationship.summary
            },
            version: (character.version ?? 1) + 1
          });
        }
        return json(result, 201);
      } catch (cause) {
        if (createdCharacter) await repository.deleteCharacter(user.user_id, character.character_id);
        throw cause;
      }
    }

    if (request.method === 'GET' && path === '/v1/characters') {
      const characters = await repository.listCharacters(user.user_id);
      return json({ characters: characters.map(listCharacter) });
    }
    if (request.method === 'POST' && path === '/v1/characters') {
      const normalized = normalizeCharacter(await request.json());
      const metadata = {
        compatibility_level: 'FORMAL',
        format: 'LiteTavern',
        container: 'JSON',
        unapplied_fields: []
      };
      const record = createRecord(normalized, metadata);
      await repository.createCharacter(user.user_id, record);
      return json({ character_id: record.character_id }, 201);
    }
    if (request.method === 'POST' && path === '/v1/characters/import/preview') {
      const { parsed } = await uploadedCard(request);
      const preview = { ...parsed };
      delete preview.source_card;
      delete preview.content_type;
      return json(preview);
    }
    if (request.method === 'POST' && path === '/v1/characters/import') {
      const { bytes, parsed } = await uploadedCard(request);
      const record = createRecord(
        parsed.normalized_data,
        parsed.source_metadata,
        null
      );
      record.raw_object_key = `users/${user.user_id}/characters/${record.character_id}/card`;
      await objects.put(record.raw_object_key, bytes, parsed.content_type);
      try {
        await repository.createCharacter(user.user_id, record);
      } catch (cause) {
        await objects.delete(record.raw_object_key);
        throw cause;
      }
      return json({ character_id: record.character_id }, 201);
    }

    const cardMatch = path.match(/^\/v1\/characters\/([^/]+)\/card$/);
    if (cardMatch) {
      const character = await repository.getCharacter(user.user_id, cardMatch[1]);
      if (!character) return error('NOT_FOUND', '角色不存在。', 404);
      if (request.method === 'GET') return json(publicCardDetail(character));
      if (request.method === 'PUT') {
        const normalized = normalizeCharacter(await request.json());
        const updated = await repository.updateCharacter(user.user_id, cardMatch[1], {
          normalized_data: normalized,
          version: (character.version ?? 1) + 1
        });
        return updated
          ? json({ character_id: cardMatch[1] })
          : error('NOT_FOUND', '角色不存在。', 404);
      }
    }

    const avatarMatch = path.match(/^\/v1\/characters\/([^/]+)\/avatar$/);
    if (avatarMatch) {
      const character = await repository.getCharacter(user.user_id, avatarMatch[1]);
      if (!character) return error('NOT_FOUND', '角色不存在。', 404);
      if (request.method === 'GET') {
        if (!character.avatar_object_key) {
          return error('NOT_FOUND', '该角色没有头像。', 404);
        }
        const object = await objects.get(character.avatar_object_key);
        if (!object) return error('NOT_FOUND', '头像文件不存在。', 404);
        return new Response(object.bytes, {
          headers: {
            'Cache-Control': 'private, max-age=3600',
            'Content-Type': object.contentType ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex, nofollow'
          }
        });
      }
      if (request.method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function') {
          throw new ApiFault('FILE_REQUIRED', '请选择头像文件。', 400);
        }
        if (!file.type?.startsWith('image/')) {
          throw new ApiFault('INVALID_AVATAR', '头像必须是图片。', 400);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > 5 * 1024 * 1024) {
          throw new ApiFault('INVALID_AVATAR', '头像不能超过 5 MB。', 400);
        }
        const key = `users/${user.user_id}/characters/${avatarMatch[1]}/avatar`;
        await objects.put(key, bytes, file.type);
        await repository.updateCharacter(user.user_id, avatarMatch[1], {
          avatar_object_key: key,
          version: (character.version ?? 1) + 1
        });
        return json({ avatar_updated: true });
      }
      if (request.method === 'DELETE') {
        if (character.avatar_object_key) await objects.delete(character.avatar_object_key);
        await repository.updateCharacter(user.user_id, avatarMatch[1], {
          avatar_object_key: null,
          version: (character.version ?? 1) + 1
        });
        return json({ avatar_deleted: true });
      }
    }

    const exportMatch = path.match(/^\/v1\/characters\/([^/]+)\/export$/);
    if (request.method === 'GET' && exportMatch) {
      const character = await repository.getCharacter(user.user_id, exportMatch[1]);
      if (!character) return error('NOT_FOUND', '角色不存在。', 404);
      if (character.raw_object_key) {
        const object = await objects.get(character.raw_object_key);
        if (object) {
          return new Response(object.bytes, {
            headers: {
              'Content-Disposition': `attachment; filename="character-${character.character_id}"`,
              'Content-Type': object.contentType ?? 'application/octet-stream',
              'X-Content-Type-Options': 'nosniff'
            }
          });
        }
      }
      return new Response(JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          ...character.normalized_data,
          first_mes: character.normalized_data.first_message,
          mes_example: character.normalized_data.example_messages
        }
      }), {
        headers: {
          'Content-Disposition': `attachment; filename="character-${character.character_id}.json"`,
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }

    const characterMatch = path.match(/^\/v1\/characters\/([^/]+)$/);
    if (request.method === 'DELETE' && characterMatch) {
      const removed = await repository.deleteCharacter(user.user_id, characterMatch[1]);
      if (!removed) return error('NOT_FOUND', '角色不存在。', 404);
      if (removed.raw_object_key) await objects.delete(removed.raw_object_key);
      if (removed.avatar_object_key) await objects.delete(removed.avatar_object_key);
      return json({ deleted: true });
    }

    if (request.method === 'POST' && path === '/v1/conversations') {
      const body = await request.json();
      const character = await repository.getCharacter(
        user.user_id,
        string(body.character_id)
      );
      if (!character) return error('NOT_FOUND', '角色不存在。', 404);
      const conversationId = await repository.getOrCreateConversation(
        user.user_id,
        character
      );
      return json({ conversation_id: conversationId }, 201);
    }

    const messagesMatch = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
    if (request.method === 'GET' && messagesMatch) {
      const messages = await repository.listMessages(user.user_id, messagesMatch[1]);
      return messages === null
        ? error('NOT_FOUND', '会话不存在。', 404)
        : json({ messages });
    }

    const memoriesMatch = path.match(/^\/v1\/characters\/([^/]+)\/memories$/);
    if (request.method === 'GET' && memoriesMatch) {
      const character = await repository.getCharacter(user.user_id, memoriesMatch[1]);
      return character
        ? json({ memories: await repository.listMemories(user.user_id, memoriesMatch[1]) })
        : error('NOT_FOUND', '角色不存在。', 404);
    }

    const memoryMatch = path.match(/^\/v1\/memories\/([^/]+)$/);
    if (request.method === 'DELETE' && memoryMatch) {
      const deleted = await repository.deleteMemory(user.user_id, memoryMatch[1]);
      return deleted
        ? json({ deleted: true })
        : error('NOT_FOUND', '记忆不存在。', 404);
    }

    if (/^\/v1\/conversations\/[^/]+\/(turns|generations|reply-suggestions)$/.test(path)) {
      return error(
        'MODEL_SERVICE_UNAVAILABLE',
        '内测环境的模型服务尚未启用，请先配置自己的模型服务。',
        503,
        true
      );
    }

    return error('NOT_FOUND', '接口不存在。', 404);
  } catch (cause) {
    if (cause instanceof ApiFault) {
      return error(cause.code, cause.message, cause.status, cause.retryable);
    }
    console.error('Internal API request failed', {
      path: new URL(request.url).pathname,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return error('INTERNAL_ERROR', '服务暂时不可用，请稍后重试。', 500, true);
  }
}

function parseJsonColumn(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateCharacter(row) {
  return {
    ...row,
    normalized_data: parseJsonColumn(row.normalized_data, {}),
    source_metadata: parseJsonColumn(row.source_metadata, {}),
    source_card: parseJsonColumn(row.source_card, null),
    warnings: parseJsonColumn(row.warnings, [])
  };
}

function listCharacter(row) {
  const character = typeof row.normalized_data === 'string'
    ? hydrateCharacter(row)
    : row;
  return {
    character_id: character.character_id,
    name: character.normalized_data.name,
    profile_summary: character.normalized_data.description,
    personality_summary: character.normalized_data.personality,
    first_message: character.normalized_data.first_message,
    avatar_seed: character.normalized_data.name,
    version: character.version,
    is_owned: true,
    conversation_id: character.conversation_id ?? null,
    last_message: character.last_message ?? null
  };
}

export class D1Repository {
  constructor(database) {
    this.database = database;
  }

  async createIdentity(sessionTokenHash) {
    const userId = crypto.randomUUID();
    const anonymousId = crypto.randomUUID();
    await this.database.batch([
      this.database.prepare(
        'INSERT INTO app_user (user_id, created_at) VALUES (?, ?)'
      ).bind(userId, new Date().toISOString()),
      this.database.prepare(
        'INSERT INTO app_identity (session_token_hash, user_id, anonymous_id, created_at) VALUES (?, ?, ?, ?)'
      ).bind(sessionTokenHash, userId, anonymousId, new Date().toISOString())
    ]);
    return { user_id: userId, anonymous_id: anonymousId };
  }

  async findIdentity(sessionTokenHash) {
    return this.database.prepare(
      'SELECT user_id, anonymous_id FROM app_identity WHERE session_token_hash = ?'
    ).bind(sessionTokenHash).first();
  }

  async createRelationshipImport(userId, importId, payload) {
    await this.database.prepare(`
      INSERT INTO relationship_import (
        import_id, user_id, status, payload, created_at
      ) VALUES (?, ?, 'PENDING', ?, ?)
    `).bind(importId, userId, JSON.stringify(payload), new Date().toISOString()).run();
  }

  async getRelationshipImport(userId, importId) {
    const row = await this.database.prepare(`
      SELECT import_id, status, payload, result
      FROM relationship_import
      WHERE import_id = ? AND user_id = ?
    `).bind(importId, userId).first();
    return row ? {
      ...row,
      payload: parseJsonColumn(row.payload, null),
      result: parseJsonColumn(row.result, null)
    } : null;
  }

  async commitRelationshipImport(
    userId,
    importId,
    characterId,
    conversationId,
    payload,
    processedAt,
    createdCharacter
  ) {
    const statements = [
      this.database.prepare(`
        INSERT INTO character_relationship (
          character_id, user_id, summary, stage, user_addressing,
          interaction_patterns, user_profile, unfinished_threads,
          source_metadata, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(character_id) DO UPDATE SET
          summary = excluded.summary,
          stage = excluded.stage,
          user_addressing = excluded.user_addressing,
          interaction_patterns = excluded.interaction_patterns,
          user_profile = excluded.user_profile,
          unfinished_threads = excluded.unfinished_threads,
          source_metadata = excluded.source_metadata,
          updated_at = excluded.updated_at
      `).bind(
        characterId,
        userId,
        payload.relationship.summary,
        payload.relationship.stage,
        JSON.stringify(payload.relationship.user_addressing),
        JSON.stringify(payload.relationship.interaction_patterns),
        JSON.stringify(payload.user_profile),
        JSON.stringify(payload.unfinished_threads),
        JSON.stringify(payload.source_metadata),
        processedAt
      )
    ];
    for (const memory of payload.memories) {
      statements.push(this.database.prepare(`
        INSERT OR IGNORE INTO memory (
          memory_id, user_id, character_id, content, memory_kind, importance,
          approximate_time, tags, evidence_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        userId,
        characterId,
        memory.content,
        memory.tags[0] || '共同记忆',
        memory.importance,
        memory.approximate_time,
        JSON.stringify(memory.tags),
        memory.evidence_summary,
        processedAt
      ));
    }
    const results = await this.database.batch(statements);
    const memoriesWritten = results
      .slice(1)
      .reduce((total, item) => total + (item.meta?.changes ?? 0), 0);
    const result = {
      import_id: importId,
      character_id: characterId,
      conversation_id: conversationId,
      created_character: createdCharacter,
      memories_written: memoriesWritten,
      already_committed: false
    };
    const committed = await this.database.prepare(`
      UPDATE relationship_import
      SET status = 'COMMITTED', payload = ?, result = ?, processed_at = ?,
          character_id = ?, conversation_id = ?
      WHERE import_id = ? AND user_id = ? AND status = 'PENDING'
    `).bind(
      JSON.stringify(payload),
      JSON.stringify(result),
      processedAt,
      characterId,
      conversationId,
      importId,
      userId
    ).run();
    if (committed.meta.changes === 0) {
      const existing = await this.getRelationshipImport(userId, importId);
      if (existing?.result) return { ...existing.result, already_committed: true };
      throw new Error('Relationship import commit state changed unexpectedly.');
    }
    return result;
  }

  async listMemories(userId, characterId) {
    const result = await this.database.prepare(`
      SELECT memory_id, content, memory_kind, importance, approximate_time,
             tags, evidence_summary, created_at
      FROM memory
      WHERE user_id = ? AND character_id = ?
      ORDER BY importance DESC, created_at DESC
    `).bind(userId, characterId).all();
    return result.results.map((row) => ({
      ...row,
      tags: parseJsonColumn(row.tags, [])
    }));
  }

  async deleteMemory(userId, memoryId) {
    const result = await this.database.prepare(
      'DELETE FROM memory WHERE user_id = ? AND memory_id = ?'
    ).bind(userId, memoryId).run();
    return result.meta.changes > 0;
  }

  async listCharacters(userId) {
    const result = await this.database.prepare(`
      SELECT c.*,
        conv.conversation_id,
        (
          SELECT m.content_text
          FROM message m
          WHERE m.conversation_id = conv.conversation_id
          ORDER BY m.sequence_no DESC
          LIMIT 1
        ) AS last_message
      FROM character c
      LEFT JOIN conversation conv
        ON conv.character_id = c.character_id AND conv.user_id = c.user_id
      WHERE c.user_id = ?
      ORDER BY c.updated_at DESC
    `).bind(userId).all();
    return result.results.map(hydrateCharacter);
  }

  async createCharacter(userId, record) {
    const now = new Date().toISOString();
    await this.database.prepare(`
      INSERT INTO character (
        character_id, user_id, normalized_data, source_metadata, source_card,
        warnings, version, raw_object_key, avatar_object_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      record.character_id,
      userId,
      JSON.stringify(record.normalized_data),
      JSON.stringify(record.source_metadata),
      record.source_card === null ? null : JSON.stringify(record.source_card),
      JSON.stringify(record.warnings ?? []),
      record.version ?? 1,
      record.raw_object_key,
      record.avatar_object_key,
      now,
      now
    ).run();
    return record.character_id;
  }

  async getCharacter(userId, characterId) {
    const row = await this.database.prepare(
      'SELECT * FROM character WHERE user_id = ? AND character_id = ?'
    ).bind(userId, characterId).first();
    return row ? hydrateCharacter(row) : null;
  }

  async updateCharacter(userId, characterId, changes) {
    const current = await this.getCharacter(userId, characterId);
    if (!current) return false;
    const next = { ...current, ...changes };
    const result = await this.database.prepare(`
      UPDATE character
      SET normalized_data = ?, source_metadata = ?, source_card = ?, warnings = ?,
          version = ?, raw_object_key = ?, avatar_object_key = ?, updated_at = ?
      WHERE user_id = ? AND character_id = ?
    `).bind(
      JSON.stringify(next.normalized_data),
      JSON.stringify(next.source_metadata),
      next.source_card === null ? null : JSON.stringify(next.source_card),
      JSON.stringify(next.warnings ?? []),
      next.version,
      next.raw_object_key,
      next.avatar_object_key,
      new Date().toISOString(),
      userId,
      characterId
    ).run();
    return result.meta.changes > 0;
  }

  async deleteCharacter(userId, characterId) {
    const current = await this.getCharacter(userId, characterId);
    if (!current) return null;
    await this.database.prepare(
      'DELETE FROM character WHERE user_id = ? AND character_id = ?'
    ).bind(userId, characterId).run();
    return current;
  }

  async getOrCreateConversation(userId, character) {
    const existing = await this.database.prepare(
      'SELECT conversation_id FROM conversation WHERE user_id = ? AND character_id = ?'
    ).bind(userId, character.character_id).first();
    if (existing) return existing.conversation_id;

    const conversationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [
      this.database.prepare(`
        INSERT INTO conversation (
          conversation_id, user_id, character_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(conversationId, userId, character.character_id, now, now)
    ];
    if (character.normalized_data.first_message) {
      statements.push(this.database.prepare(`
        INSERT INTO message (
          message_id, conversation_id, sequence_no, role, content_text,
          status, created_at
        ) VALUES (?, ?, 1, 'ASSISTANT', ?, 'COMPLETED', ?)
      `).bind(
        crypto.randomUUID(),
        conversationId,
        character.normalized_data.first_message,
        now
      ));
    }
    await this.database.batch(statements);
    return conversationId;
  }

  async listMessages(userId, conversationId) {
    const conversation = await this.database.prepare(
      'SELECT conversation_id FROM conversation WHERE user_id = ? AND conversation_id = ?'
    ).bind(userId, conversationId).first();
    if (!conversation) return null;
    const result = await this.database.prepare(`
      SELECT message_id, role, content_text, status
      FROM message
      WHERE conversation_id = ?
      ORDER BY sequence_no ASC
    `).bind(conversationId).all();
    return result.results;
  }
}

export class R2ObjectStorage {
  constructor(bucket) {
    this.bucket = bucket;
  }

  async put(key, bytes, contentType) {
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType }
    });
  }

  async get(key) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: object.httpMetadata?.contentType
    };
  }

  async delete(key) {
    await this.bucket.delete(key);
  }
}
