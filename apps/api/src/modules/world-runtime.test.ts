import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { assembleContext } from './context-assembler.js';
import {
  decideFromWorldState,
  ensureCharacterWorld,
  recordWorldTransition
} from './world-runtime.js';

let database: PomChatDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function createPlayerWorld() {
  if (!database) throw new Error('database not initialized');
  const userId = randomUUID();
  const characterId = randomUUID();
  const conversationId = randomUUID();
  await database.query('INSERT INTO app_user (user_id) VALUES ($1)', [userId]);
  await database.query(
    `INSERT INTO agent_character (
       character_id, visibility, name, profile_summary,
       personality_summary, first_message, status
     ) VALUES ($1, 'PLATFORM', '林岚', '独立调查员',
               '谨慎、重视承诺，但会给人修复关系的机会', '你来了。', 'ACTIVE')`,
    [characterId]
  );
  await database.query(
    `INSERT INTO chat_conversation (
       conversation_id, user_id, character_id, title
     ) VALUES ($1, $2, $3, '因果切片')`,
    [conversationId, userId, characterId]
  );
  const worldId = await ensureCharacterWorld(database, {
    userId,
    characterId,
    conversationId
  });
  return { userId, characterId, conversationId, worldId };
}

const helpRule = {
  decisionKey: 'choose_help_recipient',
  dimension: 'reliability',
  threshold: 0,
  pass: {
    outcomeKey: 'ASK_PLAYER',
    rationale: '过去的可靠表现足以支持再次托付。',
    presentation: '林岚决定再次把重要的事托付给你。'
  },
  fail: {
    outcomeKey: 'SEEK_OTHER_HELP',
    rationale: '过去的失约仍使她无法把关键任务交给玩家。',
    presentation: '林岚没有再向你求助，而是联系了别人。'
  }
} as const;

describe('causal world runtime', () => {
  it('keeps two player paths different across repeated decisions while preserving one character core', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const keptPath = await createPlayerWorld();
    const missedPath = await createPlayerWorld();

    const kept = await recordWorldTransition(database, {
      ...keptPath,
      fact: {
        factType: 'PLAYER_ACTION',
        actorKey: 'PLAYER',
        targetKey: 'CHARACTER',
        sceneKey: 'request_for_help',
        summary: '玩家按约定及时出现并完成了帮助。',
        detail: { outcome: 'KEPT_COMMITMENT' },
        reversibility: 'IRREVERSIBLE'
      },
      characterKnowledge: {
        interpretation: '玩家在重要承诺上是可靠的。',
        certainty: 'KNOWN'
      },
      relationship: {
        dimensions: { reliability: 2, trust: 1 },
        reason: '兑现承诺',
        unresolved: false
      },
      state: {
        emotion: { toward_player: '安心' },
        currentGoal: '完成后续调查'
      }
    });
    const missed = await recordWorldTransition(database, {
      ...missedPath,
      fact: {
        factType: 'PLAYER_ACTION',
        actorKey: 'PLAYER',
        targetKey: 'CHARACTER',
        sceneKey: 'request_for_help',
        summary: '玩家答应帮忙后没有出现。',
        detail: { outcome: 'BROKE_COMMITMENT' },
        reversibility: 'COMPENSATABLE'
      },
      characterKnowledge: {
        interpretation: '玩家的承诺目前不能作为关键安排的唯一依据。',
        certainty: 'KNOWN'
      },
      relationship: {
        dimensions: { reliability: -3, trust: -1 },
        reason: '失约且没有提前说明',
        unresolved: true
      },
      state: {
        emotion: { toward_player: '失望且戒备' },
        currentGoal: '寻找可靠的协助者'
      }
    });

    const keptDecision = await decideFromWorldState(database, {
      ...keptPath,
      rule: helpRule
    });
    const firstMissedDecision = await decideFromWorldState(database, {
      ...missedPath,
      rule: helpRule
    });
    const secondMissedDecision = await decideFromWorldState(database, {
      ...missedPath,
      rule: helpRule
    });

    expect(keptDecision.outcomeKey).toBe('ASK_PLAYER');
    expect(firstMissedDecision.outcomeKey).toBe('SEEK_OTHER_HELP');
    expect(secondMissedDecision.outcomeKey).toBe('SEEK_OTHER_HELP');
    expect(keptDecision.factIds).toContain(kept.factId);
    expect(firstMissedDecision.factIds).toContain(missed.factId);

    const presentations = await database.query<{ content_text: string }>(
      `SELECT content_text FROM chat_message
       WHERE conversation_id = $1 AND role = 'EVENT'
       ORDER BY sequence_no`,
      [missedPath.conversationId]
    );
    expect(presentations.rows.map((row) => row.content_text)).toEqual([
      helpRule.fail.presentation,
      helpRule.fail.presentation
    ]);
  });

  it('allows repair to change the future without deleting the original history', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const path = await createPlayerWorld();
    const missed = await recordWorldTransition(database, {
      ...path,
      fact: {
        factType: 'PLAYER_ACTION',
        actorKey: 'PLAYER',
        targetKey: 'CHARACTER',
        sceneKey: 'request_for_help',
        summary: '玩家答应帮忙后没有出现。',
        detail: { outcome: 'BROKE_COMMITMENT' },
        reversibility: 'COMPENSATABLE'
      },
      characterKnowledge: {
        interpretation: '玩家的承诺暂时不可靠。',
        certainty: 'KNOWN'
      },
      relationship: {
        dimensions: { reliability: -3 },
        reason: '失约',
        unresolved: true
      }
    });

    expect((await decideFromWorldState(database, { ...path, rule: helpRule })).outcomeKey)
      .toBe('SEEK_OTHER_HELP');
    if (!missed.relationshipChangeId) throw new Error('missing relationship change');

    const repair = await recordWorldTransition(database, {
      ...path,
      fact: {
        factType: 'PLAYER_ACTION',
        actorKey: 'PLAYER',
        targetKey: 'CHARACTER',
        sceneKey: 'relationship_repair',
        summary: '玩家承认失约、解释原因，并在新的约定中持续兑现承诺。',
        detail: { outcome: 'REPAIRED_TRUST' },
        reversibility: 'IRREVERSIBLE'
      },
      characterKnowledge: {
        interpretation: '过去的失约仍发生过，但玩家正在用行动修复可靠性。',
        certainty: 'KNOWN'
      },
      relationship: {
        dimensions: { reliability: 4 },
        reason: '通过新的行动修复信任',
        unresolved: false,
        repairsChangeId: missed.relationshipChangeId
      }
    });

    const afterRepair = await decideFromWorldState(database, {
      ...path,
      rule: helpRule
    });
    expect(afterRepair.outcomeKey).toBe('ASK_PLAYER');
    expect(afterRepair.factIds).toEqual(expect.arrayContaining([missed.factId, repair.factId]));

    const facts = await database.query<{ fact_id: string; summary: string }>(
      'SELECT fact_id, summary FROM world_fact WHERE world_id = $1 ORDER BY occurred_at',
      [path.worldId]
    );
    expect(facts.rows).toEqual([
      expect.objectContaining({ fact_id: missed.factId, summary: '玩家答应帮忙后没有出现。' }),
      expect.objectContaining({ fact_id: repair.factId })
    ]);
    await expect(
      database.query('DELETE FROM world_fact WHERE fact_id = $1', [missed.factId])
    ).rejects.toThrow();
  });

  it('places objective history after card prompts and separates facts, beliefs, state, and plans', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const path = await createPlayerWorld();
    await recordWorldTransition(database, {
      ...path,
      fact: {
        factType: 'PLAYER_ACTION',
        actorKey: 'PLAYER',
        targetKey: 'CHARACTER',
        sceneKey: 'request_for_help',
        summary: '玩家答应帮忙后没有出现。',
        detail: { outcome: 'BROKE_COMMITMENT' },
        reversibility: 'COMPENSATABLE'
      },
      characterKnowledge: {
        interpretation: '她认为玩家目前不够可靠。',
        certainty: 'KNOWN'
      },
      relationship: {
        dimensions: { reliability: -3 },
        reason: '失约',
        unresolved: true
      },
      state: {
        emotion: { toward_player: '失望' },
        currentGoal: '确保下一次行动不再落空',
        currentPlan: '先联系备用协助者'
      }
    });

    const context = await assembleContext(database, path.userId, path.conversationId);
    expect(context.system).toContain('世界正史（已经发生，不得否认、删除或改写）');
    expect(context.system).toContain('玩家答应帮忙后没有出现。');
    expect(context.system).toContain('角色主观认知（可能不完整或有误）');
    expect(context.system).toContain('她认为玩家目前不够可靠。');
    expect(context.system).toContain('临时状态（会变化，不是历史事实）');
    expect(context.system).toContain('当前计划（尚未发生，不得描述成既成事实）');
    expect(context.manifest.world_id).toBe(path.worldId);
    expect(context.manifest.fact_ids).toHaveLength(1);
  });
});
