import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  handleApiRequest,
  parseCharacterCard
} from '../deploy/internal-gate/api.js';

class MemoryRepository {
  identities = new Map();
  characters = new Map();
  conversations = new Map();
  messages = new Map();
  relationshipImports = new Map();
  memories = new Map();

  async createIdentity(tokenHash) {
    const user = {
      user_id: crypto.randomUUID(),
      anonymous_id: crypto.randomUUID()
    };
    this.identities.set(tokenHash, user);
    return user;
  }

  async findIdentity(tokenHash) {
    return this.identities.get(tokenHash) ?? null;
  }

  async listCharacters(userId) {
    return [...this.characters.values()].filter((item) => item.user_id === userId);
  }

  async createCharacter(userId, record) {
    this.characters.set(record.character_id, { ...record, user_id: userId });
    return record.character_id;
  }

  async getCharacter(userId, characterId) {
    const character = this.characters.get(characterId);
    return character?.user_id === userId ? character : null;
  }

  async updateCharacter(userId, characterId, record) {
    const current = await this.getCharacter(userId, characterId);
    if (!current) return false;
    this.characters.set(characterId, { ...current, ...record });
    return true;
  }

  async deleteCharacter(userId, characterId) {
    const current = await this.getCharacter(userId, characterId);
    if (!current) return null;
    this.characters.delete(characterId);
    return current;
  }

  async getOrCreateConversation(userId, character) {
    const existing = [...this.conversations.values()].find(
      (item) => item.user_id === userId && item.character_id === character.character_id
    );
    if (existing) return existing.conversation_id;
    const conversationId = crypto.randomUUID();
    this.conversations.set(conversationId, {
      conversation_id: conversationId,
      user_id: userId,
      character_id: character.character_id
    });
    this.messages.set(
      conversationId,
      character.normalized_data.first_message
        ? [{
            message_id: crypto.randomUUID(),
            role: 'ASSISTANT',
            content_text: character.normalized_data.first_message,
            status: 'COMPLETED'
          }]
        : []
    );
    return conversationId;
  }

  async listMessages(userId, conversationId) {
    const conversation = this.conversations.get(conversationId);
    return conversation?.user_id === userId
      ? (this.messages.get(conversationId) ?? [])
      : null;
  }

  async createRelationshipImport(userId, importId, payload) {
    this.relationshipImports.set(importId, {
      import_id: importId,
      user_id: userId,
      status: 'PENDING',
      payload,
      result: null
    });
  }

  async getRelationshipImport(userId, importId) {
    const record = this.relationshipImports.get(importId);
    return record?.user_id === userId ? record : null;
  }

  async commitRelationshipImport(
    userId,
    importId,
    characterId,
    conversationId,
    payload,
    _processedAt,
    createdCharacter
  ) {
    const record = await this.getRelationshipImport(userId, importId);
    if (record.status === 'COMMITTED') return { ...record.result, already_committed: true };
    let memoriesWritten = 0;
    for (const memory of payload.memories) {
      const duplicate = [...this.memories.values()].some(
        (entry) => entry.character_id === characterId && entry.content === memory.content
      );
      if (duplicate) continue;
      const memoryId = crypto.randomUUID();
      this.memories.set(memoryId, {
        ...memory,
        memory_id: memoryId,
        user_id: userId,
        character_id: characterId,
        memory_kind: memory.tags[0] || '共同记忆',
        created_at: payload.source_metadata.processed_at
      });
      memoriesWritten += 1;
    }
    record.payload = payload;
    record.status = 'COMMITTED';
    record.result = {
      import_id: importId,
      character_id: characterId,
      conversation_id: conversationId,
      created_character: createdCharacter,
      memories_written: memoriesWritten,
      already_committed: false
    };
    return record.result;
  }

  async listMemories(userId, characterId) {
    return [...this.memories.values()].filter(
      (memory) => memory.user_id === userId && memory.character_id === characterId
    );
  }

  async deleteMemory(userId, memoryId) {
    const memory = this.memories.get(memoryId);
    if (!memory || memory.user_id !== userId) return false;
    this.memories.delete(memoryId);
    return true;
  }
}

class MemoryObjects {
  values = new Map();

  async put(key, bytes, contentType) {
    this.values.set(key, { bytes, contentType });
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

function pngCard(card) {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const data = new TextEncoder().encode(`chara\0${btoa(JSON.stringify(card))}`);
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length);
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  chunk.set(data, 8);
  return new Blob([signature, chunk], { type: 'image/png' });
}

async function identity(repository, objects) {
  const response = await handleApiRequest(
    new Request('https://internal.example/v1/identities/anonymous', {
      method: 'POST',
      headers: { Origin: 'https://internal.example' }
    }),
    { repository, objects }
  );
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

test('creates an anonymous identity, character and resumable opening conversation', async () => {
  const repository = new MemoryRepository();
  const objects = new MemoryObjects();
  const cookie = await identity(repository, objects);

  const created = await handleApiRequest(
    new Request('https://internal.example/v1/characters', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://internal.example'
      },
      body: JSON.stringify({
        name: '流萤',
        description: '测试角色',
        personality: '',
        scenario: '',
        first_message: '你好。',
        alternate_greetings: [],
        example_messages: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: { name: '', notes: '', character_version: '' }
      })
    }),
    { repository, objects }
  );
  assert.equal(created.status, 201);
  const characterId = (await created.json()).character_id;

  const listed = await handleApiRequest(
    new Request('https://internal.example/v1/characters', {
      headers: { Cookie: cookie }
    }),
    { repository, objects }
  );
  assert.deepEqual(
    (await listed.json()).characters.map((item) => item.name),
    ['流萤']
  );

  const conversation = await handleApiRequest(
    new Request('https://internal.example/v1/conversations', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://internal.example'
      },
      body: JSON.stringify({ character_id: characterId })
    }),
    { repository, objects }
  );
  const conversationId = (await conversation.json()).conversation_id;
  const messages = await handleApiRequest(
    new Request(`https://internal.example/v1/conversations/${conversationId}/messages`, {
      headers: { Cookie: cookie }
    }),
    { repository, objects }
  );
  assert.deepEqual(
    (await messages.json()).messages.map((item) => item.content_text),
    ['你好。']
  );
});

test('previews and imports the reported CCv2 PNG shape into object storage', async () => {
  const repository = new MemoryRepository();
  const objects = new MemoryObjects();
  const cookie = await identity(repository, objects);
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Hotaru',
      description: 'College AU',
      personality: 'Kind',
      first_mes: 'Hello',
      extensions: { retained: true }
    }
  };
  const file = pngCard(card);

  const previewForm = new FormData();
  previewForm.append('file', file, 'main_firefly_spec_v2.png');
  const preview = await handleApiRequest(
    new Request('https://internal.example/v1/characters/import/preview', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://internal.example' },
      body: previewForm
    }),
    { repository, objects }
  );
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).character.name, 'Hotaru');

  const importForm = new FormData();
  importForm.append('file', file, 'main_firefly_spec_v2.png');
  const imported = await handleApiRequest(
    new Request('https://internal.example/v1/characters/import', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://internal.example' },
      body: importForm
    }),
    { repository, objects }
  );
  assert.equal(imported.status, 201);
  assert.equal(objects.values.size, 1);
  const persisted = [...repository.characters.values()][0];
  assert.equal(persisted.source_card, null);
});

test('normalizes unknown API routes to JSON instead of an empty Pages response', async () => {
  const repository = new MemoryRepository();
  const objects = new MemoryObjects();
  const cookie = await identity(repository, objects);
  const response = await handleApiRequest(
    new Request('https://internal.example/v1/not-real', {
      headers: { Cookie: cookie }
    }),
    { repository, objects }
  );
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});

test('rejects malformed card data without persisting it', async () => {
  assert.throws(
    () => parseCharacterCard(new TextEncoder().encode('not-json'), 'bad.json'),
    /无法识别/
  );
});

test('validates and commits a relationship import with a server-owned processed_at', async () => {
  const repository = new MemoryRepository();
  const objects = new MemoryObjects();
  const cookie = await identity(repository, objects);
  const migration = {
    schema_version: 'litetavern_relationship_import_v1',
    character: {
      name: '林岚',
      description: '虚构电台主持人',
      personality_traits: ['耐心'],
      speaking_style: ['简洁']
    },
    user_profile: {
      preferred_name: '小舟',
      facts: [],
      preferences: ['雨声'],
      boundaries: []
    },
    // Legacy v1 payload: user_addressing did not exist yet.
    relationship: {
      summary: '两人已经成为会彼此关心的朋友。',
      stage: '亲密朋友',
      interaction_patterns: ['睡前互道晚安']
    },
    memories: [{
      content: '两人一起听完了虚构节目《夜航》的最后一期。',
      importance: 8,
      approximate_time: null,
      tags: ['共同经历'],
      evidence_summary: '双方在聊天中共同回顾。'
    }],
    unfinished_threads: [],
    uncertain_items: [],
    source_metadata: {
      source_platform: '',
      character_name_on_source: '林岚',
      processed_at: null,
      notes: ''
    }
  };

  const validated = await handleApiRequest(
    new Request('https://internal.example/v1/relationship-imports/validate', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://internal.example'
      },
      body: JSON.stringify({ raw_text: JSON.stringify(migration) })
    }),
    { repository, objects }
  );
  assert.equal(validated.status, 200);
  const validation = await validated.json();
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.preview.relationship.user_addressing, []);
  assert.equal(validation.preview.source_metadata.processed_at, null);

  const committed = await handleApiRequest(
    new Request('https://internal.example/v1/relationship-imports/commit', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://internal.example'
      },
      body: JSON.stringify({
        import_id: validation.import_id,
        mode: 'CREATE',
        keep_uncertain_items: true,
        payload: {
          schema_version: migration.schema_version,
          character: validation.preview.character,
          user_profile: validation.preview.user_profile,
          relationship: validation.preview.relationship,
          memories: validation.preview.memories.map((memory) => ({
            content: memory.content,
            importance: memory.importance,
            approximate_time: memory.approximate_time,
            tags: memory.tags,
            evidence_summary: memory.evidence_summary
          })),
          unfinished_threads: validation.preview.unfinished_threads,
          uncertain_items: validation.preview.uncertain_items,
          source_metadata: validation.preview.source_metadata
        }
      })
    }),
    { repository, objects }
  );
  assert.equal(committed.status, 201);
  const result = await committed.json();
  assert.equal(result.memories_written, 1);
  const staged = repository.relationshipImports.get(validation.import_id);
  assert.match(staged.payload.source_metadata.processed_at, /^\d{4}-\d{2}-\d{2}T/);

  const listed = await handleApiRequest(
    new Request(`https://internal.example/v1/characters/${result.character_id}/memories`, {
      headers: { Cookie: cookie }
    }),
    { repository, objects }
  );
  assert.equal((await listed.json()).memories.length, 1);

  const repeated = await handleApiRequest(
    new Request('https://internal.example/v1/relationship-imports/commit', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://internal.example'
      },
      body: JSON.stringify({ import_id: validation.import_id })
    }),
    { repository, objects }
  );
  assert.equal((await repeated.json()).already_committed, true);
  assert.equal(repository.memories.size, 1);
});

test('relationship validation rejects non-JSON model commentary', async () => {
  const repository = new MemoryRepository();
  const objects = new MemoryObjects();
  const cookie = await identity(repository, objects);
  const response = await handleApiRequest(
    new Request('https://internal.example/v1/relationship-imports/validate', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://internal.example'
      },
      body: JSON.stringify({ raw_text: '以下是结果：\n```json\n{}\n```' })
    }),
    { repository, objects }
  );
  const body = await response.json();
  assert.equal(body.valid, false);
  assert.equal(body.import_id, null);
  assert.ok(body.issues.some((issue) => issue.code === 'INVALID_JSON'));
});

/** Top-level field names of an exported interface in the client's cloud contract. */
function contractFields(text, name) {
  const source = text.replace(/\r\n/g, '\n');
  const opens = source.indexOf(`export interface ${name} {`);
  assert.ok(opens > -1, `missing the ${name} contract`);
  const closes = source.indexOf('\n}', opens);
  const body = source.slice(opens, closes);
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
}

test('the internal cloud status answers with every field the client contract declares', async () => {
  const repository = new MemoryRepository();
  const objects = new MemoryObjects();
  const cookie = await identity(repository, objects);
  const response = await handleApiRequest(
    new Request('https://internal.example/v1/cloud/status', {
      headers: { Cookie: cookie }
    }),
    { repository, objects }
  );

  assert.equal(response.status, 200);
  const { cloud } = await response.json();

  // The client reads a missing field as a broken service rather than as unknown:
  // an absent model_service alone makes the whole environment report an outage.
  const contract = await readFile(
    new URL('../apps/web/src/lib/cloud.ts', import.meta.url),
    'utf8'
  );
  for (const field of contractFields(contract, 'CloudStatus')) {
    assert.ok(field in cloud, `/v1/cloud/status is missing "${field}"`);
  }
  for (const field of contractFields(contract, 'CloudQuota')) {
    assert.ok(field in cloud.quota, `/v1/cloud/status quota is missing "${field}"`);
  }

  // The internal gate has no hosted model path, and it must say so honestly
  // instead of leaving the client to infer an outage from silence.
  assert.deepEqual(cloud.model_service, {
    available: false,
    reason_code: 'SERVICE_UNAVAILABLE'
  });
  assert.equal(cloud.platform_models_available, false);
});
