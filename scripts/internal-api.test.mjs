import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleApiRequest,
  parseCharacterCard
} from '../deploy/internal-gate/api.js';

class MemoryRepository {
  identities = new Map();
  characters = new Map();
  conversations = new Map();
  messages = new Map();

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
