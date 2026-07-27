import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { randomUUID } from 'node:crypto';
import { buildApp } from './app.js';
import type { ModelGateway } from './modules/providers/model-gateway.js';
import { insertTestCharacter } from './test-fixtures.js';

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const openDatabases: PomChatDatabase[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

async function setup(completeReturn = '{"messages":["第一条","第二条","第三条"]}') {
  const database = await createDatabase({ dataDir: 'memory://' });
  const gateway: ModelGateway = {
    async validate(input) {
      return { ok: true, latencyMs: 1, models: [input.model] };
    },
    async listModels() {
      return [];
    },
    async stream() {
      throw new Error('unused');
    },
    async complete() {
      return completeReturn;
    }
  };
  const app = await buildApp({
    database,
    gateway,
    platform: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'platform-only-secret',
      dailyTokenQuota: 10_000
    }
  });
  openApps.push(app);
  openDatabases.push(database);

  const identity = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
  const cookie = String(identity.headers['set-cookie']).split(';')[0] ?? '';
  const characterId = await insertTestCharacter(database);
  const conversation = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: { cookie },
    payload: { character_id: characterId }
  });
  return { app, database, cookie, conversationId: conversation.json().conversation_id as string };
}

function activeTexts(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, conversationId: string) {
  return app
    .inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers: { cookie } })
    .then((res) => (res.json().messages as Array<{ role: string; content_text: string }>).map((m) => `${m.role}:${m.content_text}`));
}

async function generateTurn(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, conversationId: string, key: string, text: string, editOf?: string) {
  const payload: Record<string, unknown> = { usage_mode: 'PLATFORM', input: { type: 'text', text } };
  if (editOf) payload.edit_of_message_id = editOf;
  const res = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/turns`,
    headers: { cookie, 'idempotency-key': key },
    payload
  });
  return res;
}

async function displayBubble(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, conversationId: string, turnId: string, text: string, bubbleNo: number, messageId = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/turns/${turnId}/bubbles`,
    headers: { cookie },
    payload: { message_id: messageId, text, bubble_no: bubbleNo }
  });
}

describe('multi-bubble turns', () => {
  it('generates a 1–4 bubble plan in a single model call without persisting bubbles', async () => {
    const { app, database, cookie, conversationId } = await setup();
    const res = await generateTurn(app, cookie, conversationId, 'turn-1', '在吗？');

    expect(res.statusCode).toBe(201);
    expect(res.json().messages).toEqual(['第一条', '第二条', '第三条']);
    // The user message is persisted, but no assistant bubbles yet.
    expect(await activeTexts(app, cookie, conversationId)).toEqual(['ASSISTANT:Hello', 'USER:在吗？']);
    const assistantCount = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM chat_message WHERE role = 'ASSISTANT' AND turn_bubble_no IS NOT NULL`
    );
    expect(assistantCount.rows[0]?.count).toBe(0);
  });

  it('persists each bubble as it is displayed, in order', async () => {
    const { app, cookie, conversationId } = await setup();
    const turnId = (await generateTurn(app, cookie, conversationId, 'turn-1', '在吗？')).json().turn_id as string;

    await displayBubble(app, cookie, conversationId, turnId, '第一条', 1);
    await displayBubble(app, cookie, conversationId, turnId, '第二条', 2);
    await displayBubble(app, cookie, conversationId, turnId, '第三条', 3);

    expect(await activeTexts(app, cookie, conversationId)).toEqual([
      'ASSISTANT:Hello',
      'USER:在吗？',
      'ASSISTANT:第一条',
      'ASSISTANT:第二条',
      'ASSISTANT:第三条'
    ]);
  });

  it('leaves undisplayed bubbles out of the database when the turn is interrupted', async () => {
    const { app, cookie, conversationId } = await setup();
    const turnId = (await generateTurn(app, cookie, conversationId, 'turn-1', '在吗？')).json().turn_id as string;

    // Only the first bubble is shown before the user sends again.
    await displayBubble(app, cookie, conversationId, turnId, '第一条', 1);

    expect(await activeTexts(app, cookie, conversationId)).toEqual([
      'ASSISTANT:Hello',
      'USER:在吗？',
      'ASSISTANT:第一条'
    ]);
  });

  it('is idempotent on the client message_id (a retried bubble is not duplicated)', async () => {
    const { app, cookie, conversationId } = await setup();
    const turnId = (await generateTurn(app, cookie, conversationId, 'turn-1', '在吗？')).json().turn_id as string;
    const messageId = randomUUID();

    const first = await displayBubble(app, cookie, conversationId, turnId, '第一条', 1, messageId);
    const retry = await displayBubble(app, cookie, conversationId, turnId, '第一条', 1, messageId);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(first.json().sequence_no).toBe(retry.json().sequence_no);
    expect(await activeTexts(app, cookie, conversationId)).toEqual([
      'ASSISTANT:Hello',
      'USER:在吗？',
      'ASSISTANT:第一条'
    ]);
  });

  it('editing a user message supersedes its branch and starts a fresh turn', async () => {
    const { app, cookie, conversationId } = await setup();
    const turnId = (await generateTurn(app, cookie, conversationId, 'turn-1', '原始问题')).json().turn_id as string;
    await displayBubble(app, cookie, conversationId, turnId, '第一条', 1);

    const editedUser = (await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: { cookie }
    }).then((r) => r.json().messages as Array<{ message_id: string; role: string; content_text: string }>))
      .find((m) => m.role === 'USER' && m.content_text === '原始问题')!.message_id;

    const edit = await generateTurn(app, cookie, conversationId, 'turn-2', '修改后的问题', editedUser);
    expect(edit.statusCode).toBe(201);

    // The active branch keeps only the opening line + the rewritten user message.
    expect(await activeTexts(app, cookie, conversationId)).toEqual([
      'ASSISTANT:Hello',
      'USER:修改后的问题'
    ]);
  });

  it('reverses the ledger and fails when the model yields an empty plan', async () => {
    const { app, database, cookie, conversationId } = await setup('{"messages":[]}');
    const res = await generateTurn(app, cookie, conversationId, 'turn-1', '在吗？');

    expect(res.statusCode).toBe(503);
    const ledger = await database.query<{ status: string }>(`SELECT status FROM model_usage_ledger`);
    expect(ledger.rows).toEqual([{ status: 'REVERSED' }]);
  });

  it('replays a generation idempotency key instead of calling the model twice', async () => {
    const { app, cookie, conversationId } = await setup();
    const first = await generateTurn(app, cookie, conversationId, 'same-turn', '在吗？');
    await displayBubble(app, cookie, conversationId, first.json().turn_id as string, '第一条', 1);

    const replay = await generateTurn(app, cookie, conversationId, 'same-turn', '在吗？');
    expect(replay.json().turn_id).toBe(first.json().turn_id);
    expect(replay.json().replayed).toBe(true);
    // The already-displayed bubble is echoed back.
    expect(replay.json().messages).toEqual(['第一条']);
  });

  it('degrades non-JSON model output to a single bubble', async () => {
    const { app, cookie, conversationId } = await setup('就这样吧，没什么好说的。');
    const res = await generateTurn(app, cookie, conversationId, 'turn-1', '在吗？');
    expect(res.json().messages).toEqual(['就这样吧，没什么好说的。']);
  });

  it('starts an empty conversation for a character created without an opening line', async () => {
    const { app, database, cookie } = await setup();
    const characterId = randomUUID();
    await database.query(
      `INSERT INTO agent_character (
         character_id, visibility, name, profile_summary,
         personality_summary, first_message, avatar_seed, status
       ) VALUES ($1, 'PLATFORM', '无开场白', 'p', 'pe', '', 'seed', 'ACTIVE')`,
      [characterId]
    );
    const conversation = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { cookie },
      payload: { character_id: characterId }
    });
    const cid = conversation.json().conversation_id as string;
    const messages = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${cid}/messages`,
      headers: { cookie }
    });
    // No blank opening bubble — the conversation is empty until someone speaks.
    expect(messages.json().messages).toEqual([]);
  });
});
