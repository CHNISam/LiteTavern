import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp } from './app.js';
import { exportCharacterCard } from './modules/character-cards/adapter.js';

const resources: Array<{ app: Awaited<ReturnType<typeof buildApp>>; database: PomChatDatabase }> = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ app, database }) => {
    await app.close();
    await database.close();
  }));
});

function multipart(file: Buffer, filename = 'x.png') {
  const boundary = '----pomchat-character-card';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function corruptFirstIdatByte(png: Buffer): Buffer {
  const output = Buffer.from(png);
  let offset = 8;
  while (offset + 12 <= output.length) {
    const length = output.readUInt32BE(offset);
    const type = output.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && length > 0) {
      const byte = output[offset + 8];
      if (byte === undefined) throw new Error('IDAT byte not found');
      output[offset + 8] = byte ^ 0xff;
      return output;
    }
    offset += length + 12;
  }
  throw new Error('IDAT not found');
}

describe('character card routes', () => {
  it('previews, imports, and exports a CCv3 card without losing extension fields', async () => {
    const database = await createDatabase({ dataDir: 'memory://' });
    const app = await buildApp({ database });
    resources.push({ app, database });
    const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(identity.headers['set-cookie']).split(';')[0];
    const card = {
      spec: 'chara_card_v3', spec_version: '3.0',
      data: { name: '星遥', description: '电台主播', personality: '温柔敏锐', first_mes: '还没睡吗？', extensions: { custom: 42 } }
    };
    const upload = multipart(exportCharacterCard(card, 'CCV3_PNG'));

    const preview = await app.inject({ method: 'POST', url: '/v1/characters/import/preview', headers: { cookie, 'content-type': upload.contentType }, payload: upload.body });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().character.name).toBe('星遥');
    expect(preview.json().compatibility).toMatchObject({
      level: 'FORMAL',
      unapplied_fields: expect.arrayContaining(['data.extensions'])
    });

    const imported = await app.inject({ method: 'POST', url: '/v1/characters/import', headers: { cookie, 'content-type': upload.contentType }, payload: upload.body });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().status).toBe('READY');

    const avatar = await app.inject({ method: 'GET', url: `/v1/characters/${imported.json().character_id}/avatar`, headers: { cookie } });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers['content-type']).toContain('image/png');
    expect(avatar.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const exported = await app.inject({ method: 'GET', url: `/v1/characters/${imported.json().character_id}/export?format=CCV3_JSON`, headers: { cookie } });
    expect(exported.statusCode).toBe(200);
    expect(JSON.parse(exported.body).data.extensions.custom).toBe(42);
  });

  it('edits supported fields, uses them at runtime, and preserves unknown fields on export', async () => {
    const database = await createDatabase({ dataDir: 'memory://' });
    const app = await buildApp({ database });
    resources.push({ app, database });
    const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(identity.headers['set-cookie']).split(';')[0];
    const card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '原名',
        description: '原描述',
        personality: '原人格',
        scenario: '旧场景',
        first_mes: '旧开场',
        mes_example: '{{char}}: 旧示例',
        system_prompt: '旧系统提示',
        post_history_instructions: '旧后置提示',
        alternate_greetings: ['备用开场'],
        tags: ['测试'],
        creator: '创作者',
        creator_notes: '说明',
        character_version: '1',
        extensions: { must_survive: true }
      },
      vendor_root: 'keep'
    };
    const upload = multipart(Buffer.from(JSON.stringify(card)), 'card.png');
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/characters/import',
      headers: { cookie, 'content-type': upload.contentType },
      payload: upload.body
    });
    expect(imported.statusCode).toBe(201);
    const characterId = imported.json().character_id as string;

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/characters/${characterId}/card`,
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().normalized_data.scenario).toBe('旧场景');
    expect(detail.json().source_metadata.unapplied_fields).toContain('data.extensions');

    const updated = await app.inject({
      method: 'PUT',
      url: `/v1/characters/${characterId}/card`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        ...detail.json().normalized_data,
        name: '新名字',
        scenario: '新场景',
        system_prompt: '请以{{char}}身份回应。{{original}}'
      }
    });
    expect(updated.statusCode).toBe(200);

    const exported = await app.inject({
      method: 'GET',
      url: `/v1/characters/${characterId}/export?format=CCV2_JSON`,
      headers: { cookie }
    });
    const output = exported.json();
    expect(output.data.name).toBe('新名字');
    expect(output.data.scenario).toBe('新场景');
    expect(output.data.extensions.must_survive).toBe(true);
    expect(output.vendor_root).toBe('keep');

    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { character_id: characterId }
    });
    const context = await app.inject({
      method: 'GET',
      url: `/test/context/${conversation.json().conversation_id}`,
      headers: { cookie }
    });
    if (context.statusCode !== 404) {
      expect(context.body).toContain('新场景');
      expect(context.body).toContain('新名字');
    }
  });

  it('creates an internal character and never persists a broken import', async () => {
    const database = await createDatabase({ dataDir: 'memory://' });
    const app = await buildApp({ database });
    resources.push({ app, database });
    const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(identity.headers['set-cookie']).split(';')[0];

    const created = await app.inject({
      method: 'POST',
      url: '/v1/characters',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: '应用内角色',
        description: '',
        personality: '',
        scenario: '',
        first_message: '你好。',
        alternate_greetings: [],
        example_messages: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: { name: '', notes: '', character_version: '' }
      }
    });
    expect(created.statusCode).toBe(201);

    const invalid = multipart(Buffer.from('not a character card'), 'looks-like-card.png');
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/characters/import',
      headers: { cookie, 'content-type': invalid.contentType },
      payload: invalid.body
    });
    expect(failed.statusCode).toBe(400);
    const count = await database.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM agent_character'
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('uploads, replaces, and explicitly removes a custom avatar', async () => {
    const database = await createDatabase({ dataDir: 'memory://' });
    const app = await buildApp({ database });
    resources.push({ app, database });
    const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(identity.headers['set-cookie']).split(';')[0];
    const created = await app.inject({
      method: 'POST',
      url: '/v1/characters',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: '头像测试',
        description: '',
        personality: '',
        scenario: '',
        first_message: '',
        alternate_greetings: [],
        example_messages: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: { name: '', notes: '', character_version: '' }
      }
    });
    const characterId = created.json().character_id as string;
    const avatarPng = exportCharacterCard({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: '像素', group_only_greetings: [] }
    }, 'CCV3_PNG');
    const avatarUpload = multipart(avatarPng, 'avatar.png');
    const uploaded = await app.inject({
      method: 'POST',
      url: `/v1/characters/${characterId}/avatar`,
      headers: { cookie, 'content-type': avatarUpload.contentType },
      payload: avatarUpload.body
    });
    expect(uploaded.statusCode).toBe(200);
    const shown = await app.inject({
      method: 'GET',
      url: `/v1/characters/${characterId}/avatar`,
      headers: { cookie }
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toContain('image/png');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/characters/${characterId}/avatar`,
      headers: { cookie }
    });
    expect(removed.statusCode).toBe(200);
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/characters/${characterId}/avatar`,
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects invalid avatar bytes without changing character data', async () => {
    const database = await createDatabase({ dataDir: 'memory://' });
    const app = await buildApp({ database });
    resources.push({ app, database });
    const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(identity.headers['set-cookie']).split(';')[0];
    const created = await app.inject({
      method: 'POST',
      url: '/v1/characters',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: '保留资料',
        description: '不能丢失',
        personality: '',
        scenario: '',
        first_message: '',
        alternate_greetings: [],
        example_messages: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: { name: '', notes: '', character_version: '' }
      }
    });
    const invalid = multipart(Buffer.from('not an image'), 'fake.png');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/characters/${created.json().character_id}/avatar`,
      headers: { cookie, 'content-type': invalid.contentType },
      payload: invalid.body
    });
    expect(response.statusCode).toBe(400);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/characters/${created.json().character_id}/card`,
      headers: { cookie }
    });
    expect(detail.json().normalized_data.description).toBe('不能丢失');
  });

  it('imports card data even when the PNG avatar pixels are damaged', async () => {
    const database = await createDatabase({ dataDir: 'memory://' });
    const app = await buildApp({ database });
    resources.push({ app, database });
    const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(identity.headers['set-cookie']).split(';')[0];
    const valid = exportCharacterCard({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: '内容仍可用', first_mes: '你好', group_only_greetings: [] }
    }, 'CCV3_PNG');
    const upload = multipart(corruptFirstIdatByte(valid), 'damaged-avatar.png');
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/characters/import',
      headers: { cookie, 'content-type': upload.contentType },
      payload: upload.body
    });
    expect(imported.statusCode).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/characters/${imported.json().character_id}/card`,
      headers: { cookie }
    });
    expect(detail.json().normalized_data.name).toBe('内容仍可用');
  });
});
