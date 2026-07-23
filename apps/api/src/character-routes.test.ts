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

function multipart(file: Buffer) {
  const boundary = '----pomchat-character-card';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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
});
