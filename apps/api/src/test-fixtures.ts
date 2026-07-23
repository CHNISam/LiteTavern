import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';

export async function insertTestCharacter(database: PomChatDatabase): Promise<string> {
  const characterId = randomUUID();
  await database.query(
    `INSERT INTO agent_character (
       character_id, visibility, name, profile_summary,
       personality_summary, first_message, avatar_seed, status
     ) VALUES ($1, 'PLATFORM', 'Test Character', 'Test profile',
               'Test personality', 'Hello', 'test-character', 'ACTIVE')`,
    [characterId]
  );
  return characterId;
}
