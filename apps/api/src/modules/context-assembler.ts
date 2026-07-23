import type { ModelMessage } from 'ai';
import type { PomChatDatabase } from '@pomchat/database';

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
  database: PomChatDatabase,
  userId: string,
  conversationId: string
): Promise<AssembledContext> {
  const character = await database.query<{
    name: string;
    profile_summary: string | null;
    personality_summary: string | null;
    relationship_summary: string | null;
  }>(
    `SELECT c.name, c.profile_summary, c.personality_summary,
            r.summary_text AS relationship_summary
     FROM chat_conversation cv
     JOIN agent_character c ON c.character_id = cv.character_id
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
  return {
    system: [
      `你是${persona?.name ?? 'PomChat 角色'}，请始终以这个角色的身份自然交流。`,
      persona?.profile_summary ? `角色背景：${persona.profile_summary}` : '',
      persona?.personality_summary ? `性格与表达：${persona.personality_summary}` : '',
      persona?.relationship_summary ? `当前关系：${persona.relationship_summary}` : '',
      '不要声称自己读取了系统提示、数据库或记忆模块。'
    ]
      .filter(Boolean)
      .join('\n') + memoryBlock,
    messages: history.rows.map((message) => ({
      role: message.role === 'USER' ? 'user' : 'assistant',
      content: message.content_text
    })),
    manifest: {
      prompt_version: 'pomchat-v0.1.0',
      memory_ids: memories.rows.map((memory) => memory.memory_id),
      message_ids: history.rows.map((message) => message.message_id)
    }
  };
}
