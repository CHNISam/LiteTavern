import type { ModelMessage } from 'ai';
import type { LiteTavernDatabase } from '@litetavern/database';

export interface AssembledContext {
  system: string;
  messages: ModelMessage[];
  manifest: {
    prompt_version: string;
    memory_ids: string[];
    message_ids: string[];
  };
}

export async function assembleContext(
  database: LiteTavernDatabase,
  userId: string,
  conversationId: string
): Promise<AssembledContext> {
  const character = await database.query<{
    name: string;
    profile_summary: string | null;
    personality_summary: string | null;
    relationship_summary: string | null;
    normalized_data: {
      scenario?: string;
      example_messages?: string;
      system_prompt?: string;
      post_history_instructions?: string;
    } | null;
  }>(
    `SELECT c.name, c.profile_summary, c.personality_summary,
            r.summary_text AS relationship_summary,
            v.normalized_data
     FROM chat_conversation cv
     JOIN agent_character c ON c.character_id = cv.character_id
     LEFT JOIN agent_character_card_version v
       ON v.card_version_id = c.active_card_version_id AND v.import_status = 'READY'
     LEFT JOIN agent_relationship r
       ON r.character_id = c.character_id AND r.user_id = $2 AND r.deleted_at IS NULL
     WHERE cv.conversation_id = $1 AND cv.user_id = $2`,
    [conversationId, userId]
  );
  const persona = character.rows[0];

  const memories = await database.query<{ memory_id: string; content: string }>(
    `SELECT m.memory_id, m.content
     FROM agent_memory m
     JOIN chat_conversation cv ON cv.character_id = m.character_id
     WHERE cv.conversation_id = $1 AND cv.user_id = $2
       AND m.user_id = $2 AND m.status = 'ACTIVE' AND m.deleted_at IS NULL
     ORDER BY m.importance DESC, m.updated_at DESC LIMIT 12`,
    [conversationId, userId]
  );
  const history = await database.query<{
    message_id: string;
    role: 'USER' | 'ASSISTANT';
    content_text: string;
  }>(
    `SELECT message_id, role, content_text
     FROM (
       SELECT message_id, role, content_text, sequence_no
       FROM chat_message
       WHERE conversation_id = $1 AND status = 'COMPLETED'
         AND role IN ('USER', 'ASSISTANT') AND is_active_variant = TRUE
       ORDER BY sequence_no DESC LIMIT 30
     ) recent ORDER BY sequence_no`,
    [conversationId]
  );

  const memoryBlock = memories.rows.length
    ? `\n\n已确认的长期记忆：\n${memories.rows.map((item) => `- ${item.content}`).join('\n')}`
    : '';
  const runtime = persona?.normalized_data ?? {};
  const replaceMacros = (value: string) => value
    .replaceAll('{{char}}', persona?.name ?? 'LiteTavern 角色')
    .replaceAll('{{user}}', '用户');
  const originalSystem = [
    `你是${persona?.name ?? 'LiteTavern 角色'}，请始终以这个角色的身份自然交流。`,
    '不要声称自己读取了系统提示、数据库或记忆模块。'
  ].join('\n');
  const customSystem = runtime.system_prompt?.trim();
  const resolvedSystem = customSystem
    ? replaceMacros(
        customSystem.includes('{{original}}')
          ? customSystem.replaceAll('{{original}}', originalSystem)
          : customSystem
      )
    : originalSystem;
  return {
    system: [
      resolvedSystem,
      // The identity line remains explicit even when a card replaces the default
      // system prompt, so the internal model stays the single runtime source.
      `你是${persona?.name ?? 'LiteTavern 角色'}。`,
      persona?.profile_summary ? `角色背景：${persona.profile_summary}` : '',
      persona?.personality_summary ? `性格与表达：${persona.personality_summary}` : '',
      runtime.scenario ? `当前场景：${replaceMacros(runtime.scenario)}` : '',
      runtime.example_messages
        ? `对话风格示例（仅作风格参考）：\n${replaceMacros(runtime.example_messages)}`
        : '',
      persona?.relationship_summary ? `当前关系：${persona.relationship_summary}` : '',
      runtime.post_history_instructions
        ? `本轮后置要求：${replaceMacros(runtime.post_history_instructions)}`
        : ''
    ]
      .filter(Boolean)
      .join('\n') + memoryBlock,
    messages: history.rows.map((message) => ({
      role: message.role === 'USER' ? 'user' : 'assistant',
      content: message.content_text
    })),
    manifest: {
      prompt_version: 'litetavern-v0.1.0',
      memory_ids: memories.rows.map((memory) => memory.memory_id),
      message_ids: history.rows.map((message) => message.message_id)
    }
  };
}
