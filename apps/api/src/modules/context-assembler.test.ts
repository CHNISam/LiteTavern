import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type LiteTavernDatabase } from '@litetavern/database';
import { assembleContext } from './context-assembler.js';

let database: LiteTavernDatabase | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe('character card runtime context', () => {
  it('uses normalized scenario, examples, and prompt fields without executing passthrough data', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const userId = randomUUID();
    const characterId = randomUUID();
    const cardVersionId = randomUUID();
    const conversationId = randomUUID();
    const normalized = {
      name: '星遥',
      description: '电台主播',
      personality: '温柔敏锐',
      scenario: '深夜节目刚刚结束',
      first_message: '还没睡吗？',
      alternate_greetings: [],
      example_messages: '{{char}}: 今晚想听什么？',
      system_prompt: '先遵循这条角色提示。{{original}}',
      post_history_instructions: '不要替用户做决定。',
      tags: [],
      creator: { name: '', notes: '', character_version: '' }
    };
    await database.query('INSERT INTO app_user (user_id) VALUES ($1)', [userId]);
    await database.query(
      `INSERT INTO agent_character (
         character_id, owner_user_id, visibility, name, profile_summary,
         personality_summary, first_message, active_card_version_id, status
       ) VALUES ($1, $2, 'PRIVATE', $3, $4, $5, $6, $7, 'ACTIVE')`,
      [characterId, userId, normalized.name, normalized.description,
        normalized.personality, normalized.first_message, cardVersionId]
    );
    await database.query(
      `INSERT INTO agent_character_card_version (
         card_version_id, character_id, version_no, source_format,
         source_spec_version, import_status, normalized_data,
         passthrough_data, source_metadata
       ) VALUES ($1, $2, 1, 'CCV3_JSON', '3.0', 'READY', $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        cardVersionId,
        characterId,
        JSON.stringify(normalized),
        JSON.stringify({ data: { extensions: { injected_prompt: 'DO NOT EXECUTE' } } }),
        JSON.stringify({ compatibility_level: 'FORMAL' })
      ]
    );
    await database.query(
      `INSERT INTO chat_conversation (
         conversation_id, user_id, character_id, title
       ) VALUES ($1, $2, $3, '测试')`,
      [conversationId, userId, characterId]
    );

    const context = await assembleContext(database, userId, conversationId);
    expect(context.system).toContain('先遵循这条角色提示。');
    expect(context.system).toContain('你是星遥');
    expect(context.system).toContain('深夜节目刚刚结束');
    expect(context.system).toContain('今晚想听什么');
    expect(context.system).toContain('不要替用户做决定。');
    expect(context.system).not.toContain('DO NOT EXECUTE');
  });
});
