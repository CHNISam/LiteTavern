import type { PomChatDatabase } from '@pomchat/database';

export async function seedPlatformData(database: PomChatDatabase) {
  await database.query(
    `UPDATE agent_character SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
     WHERE visibility = 'PLATFORM' AND character_id IN (
       '10000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000003'
     )`
  );
}
