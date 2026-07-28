import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';

type JsonScalar = string | number | boolean | null;

export interface EnsureCharacterWorldInput {
  userId: string;
  characterId: string;
  conversationId?: string;
}

export interface WorldTransitionInput extends EnsureCharacterWorldInput {
  worldId: string;
  fact: {
    factType: string;
    actorKey: string;
    targetKey?: string;
    sceneKey?: string;
    summary: string;
    detail?: Record<string, JsonScalar>;
    occurredAt?: string;
    sourceMessageId?: string;
    reversibility: 'IRREVERSIBLE' | 'COMPENSATABLE';
    supersedesFactId?: string;
  };
  characterKnowledge?: {
    certainty: 'KNOWN' | 'SUSPECTED' | 'MISUNDERSTOOD';
    interpretation: string;
  };
  relationship?: {
    dimensions: Record<string, number>;
    reason: string;
    unresolved: boolean;
    repairsChangeId?: string;
  };
  state?: {
    currentGoal?: string | null;
    currentPlan?: string | null;
    emotion?: Record<string, JsonScalar>;
  };
}

export interface CausalDecisionRule {
  decisionKey: string;
  dimension: string;
  threshold: number;
  pass: DecisionOutcome;
  fail: DecisionOutcome;
}

interface DecisionOutcome {
  outcomeKey: string;
  rationale: string;
  presentation: string;
}

export interface DecideFromWorldStateInput extends EnsureCharacterWorldInput {
  worldId: string;
  rule: CausalDecisionRule;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericDimensions(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(objectValue(value))) {
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
  }
  return result;
}

async function assertWorldScope(
  database: PomChatDatabase,
  input: { worldId: string; userId: string; characterId: string }
): Promise<void> {
  const world = await database.query(
    `SELECT 1 FROM world_instance
     WHERE world_id = $1 AND user_id = $2 AND character_id = $3 AND status = 'ACTIVE'`,
    [input.worldId, input.userId, input.characterId]
  );
  if (!world.rows[0]) throw new Error('WORLD_SCOPE_MISMATCH');
}

export async function ensureCharacterWorld(
  database: PomChatDatabase,
  input: EnsureCharacterWorldInput
): Promise<string> {
  const existing = await database.query<{ world_id: string }>(
    `SELECT world_id FROM world_instance
     WHERE user_id = $1 AND character_id = $2 AND status = 'ACTIVE'`,
    [input.userId, input.characterId]
  );
  let worldId = existing.rows[0]?.world_id;
  if (!worldId) {
    worldId = randomUUID();
    const inserted = await database.query<{ world_id: string }>(
      `INSERT INTO world_instance (world_id, user_id, character_id, title)
       VALUES ($1, $2, $3, '角色世界线')
       ON CONFLICT (user_id, character_id) DO NOTHING
       RETURNING world_id`,
      [worldId, input.userId, input.characterId]
    );
    if (!inserted.rows[0]) {
      const raced = await database.query<{ world_id: string }>(
        'SELECT world_id FROM world_instance WHERE user_id = $1 AND character_id = $2',
        [input.userId, input.characterId]
      );
      worldId = raced.rows[0]?.world_id;
    }
  }
  if (!worldId) throw new Error('WORLD_CREATE_FAILED');

  await database.query(
    `INSERT INTO character_world_state (world_id, character_id)
     VALUES ($1, $2)
     ON CONFLICT (world_id, character_id) DO NOTHING`,
    [worldId, input.characterId]
  );
  if (input.conversationId) {
    await database.query(
      `UPDATE chat_conversation SET world_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE conversation_id = $2 AND user_id = $3 AND character_id = $4
         AND (world_id IS NULL OR world_id = $1)`,
      [worldId, input.conversationId, input.userId, input.characterId]
    );
  }
  return worldId;
}

export async function recordWorldTransition(
  database: PomChatDatabase,
  input: WorldTransitionInput
): Promise<{ factId: string; relationshipChangeId: string | null; stateVersion: number }> {
  await assertWorldScope(database, input);
  const factId = randomUUID();
  const relationshipChangeId = input.relationship ? randomUUID() : null;
  let stateVersion: number | undefined;

  await database.exec('BEGIN');
  try {
    await database.query(
      `INSERT INTO world_fact (
         fact_id, world_id, fact_type, actor_key, target_key, scene_key,
         summary, detail_json, occurred_at, source_message_id,
         reversibility, supersedes_fact_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12
       )`,
      [
        factId,
        input.worldId,
        input.fact.factType,
        input.fact.actorKey,
        input.fact.targetKey ?? null,
        input.fact.sceneKey ?? null,
        input.fact.summary,
        JSON.stringify(input.fact.detail ?? {}),
        input.fact.occurredAt ?? new Date().toISOString(),
        input.fact.sourceMessageId ?? null,
        input.fact.reversibility,
        input.fact.supersedesFactId ?? null
      ]
    );
    if (input.characterKnowledge) {
      await database.query(
        `INSERT INTO character_knowledge (
           knowledge_id, world_id, character_id, fact_id, certainty, interpretation
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          input.worldId,
          input.characterId,
          factId,
          input.characterKnowledge.certainty,
          input.characterKnowledge.interpretation
        ]
      );
    }

    const current = await database.query<{
      relationship_dimensions_json: unknown;
      emotion_json: unknown;
      current_goal: string | null;
      current_plan: string | null;
      version: number;
    }>(
      `SELECT relationship_dimensions_json, emotion_json,
              current_goal, current_plan, version
       FROM character_world_state
       WHERE world_id = $1 AND character_id = $2`,
      [input.worldId, input.characterId]
    );
    const prior = current.rows[0];
    if (!prior) throw new Error('CHARACTER_WORLD_STATE_MISSING');
    const dimensions = numericDimensions(prior.relationship_dimensions_json);
    for (const [key, delta] of Object.entries(input.relationship?.dimensions ?? {})) {
      if (!Number.isFinite(delta)) throw new Error('INVALID_RELATIONSHIP_DELTA');
      dimensions[key] = (dimensions[key] ?? 0) + delta;
    }
    const emotion = {
      ...objectValue(prior.emotion_json),
      ...input.state?.emotion
    };
    stateVersion = Number(prior.version) + 1;
    await database.query(
      `UPDATE character_world_state
       SET current_goal = $3, current_plan = $4, emotion_json = $5::jsonb,
           relationship_dimensions_json = $6::jsonb, version = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE world_id = $1 AND character_id = $2`,
      [
        input.worldId,
        input.characterId,
        input.state?.currentGoal === undefined ? prior.current_goal : input.state.currentGoal,
        input.state?.currentPlan === undefined ? prior.current_plan : input.state.currentPlan,
        JSON.stringify(emotion),
        JSON.stringify(dimensions),
        stateVersion
      ]
    );
    if (input.relationship && relationshipChangeId) {
      await database.query(
        `INSERT INTO relationship_change (
           relationship_change_id, world_id, character_id, reason_fact_id,
           dimension_delta_json, reason, unresolved, repairs_change_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          relationshipChangeId,
          input.worldId,
          input.characterId,
          factId,
          JSON.stringify(input.relationship.dimensions),
          input.relationship.reason,
          input.relationship.unresolved,
          input.relationship.repairsChangeId ?? null
        ]
      );
    }
    await database.exec('COMMIT');
  } catch (error) {
    await database.exec('ROLLBACK');
    throw error;
  }
  if (stateVersion === undefined) throw new Error('CHARACTER_WORLD_STATE_UPDATE_FAILED');
  return { factId, relationshipChangeId, stateVersion };
}

export async function decideFromWorldState(
  database: PomChatDatabase,
  input: DecideFromWorldStateInput
): Promise<{ decisionId: string; outcomeKey: string; factIds: string[] }> {
  await assertWorldScope(database, input);
  const state = await database.query<{
    relationship_dimensions_json: unknown;
    version: number;
  }>(
    `SELECT relationship_dimensions_json, version
     FROM character_world_state
     WHERE world_id = $1 AND character_id = $2`,
    [input.worldId, input.characterId]
  );
  const current = state.rows[0];
  if (!current) throw new Error('CHARACTER_WORLD_STATE_MISSING');
  const dimensions = numericDimensions(current.relationship_dimensions_json);
  const value = dimensions[input.rule.dimension] ?? 0;
  const selected = value >= input.rule.threshold ? input.rule.pass : input.rule.fail;

  const changes = await database.query<{
    reason_fact_id: string;
    dimension_delta_json: unknown;
  }>(
    `SELECT reason_fact_id, dimension_delta_json
     FROM relationship_change
     WHERE world_id = $1 AND character_id = $2
     ORDER BY created_at`,
    [input.worldId, input.characterId]
  );
  const factIds = changes.rows
    .filter((row) => input.rule.dimension in numericDimensions(row.dimension_delta_json))
    .map((row) => row.reason_fact_id);
  const decisionId = randomUUID();
  const messageId = randomUUID();

  await database.exec('BEGIN');
  try {
    const conversation = await database.query<{ next_sequence_no: number; next_turn_no: number }>(
      `SELECT next_sequence_no, next_turn_no
       FROM chat_conversation
       WHERE conversation_id = $1 AND user_id = $2 AND character_id = $3
         AND world_id = $4 AND status = 'ACTIVE'`,
      [input.conversationId, input.userId, input.characterId, input.worldId]
    );
    const activeConversation = conversation.rows[0];
    if (!activeConversation) throw new Error('WORLD_CONVERSATION_MISMATCH');
    await database.query(
      `INSERT INTO chat_message (
         message_id, conversation_id, sequence_no, turn_no, role,
         content_text, content_json, status, completed_at
       ) VALUES ($1, $2, $3, $4, 'EVENT', $5, $6::jsonb, 'COMPLETED', CURRENT_TIMESTAMP)`,
      [
        messageId,
        input.conversationId,
        Number(activeConversation.next_sequence_no),
        Number(activeConversation.next_turn_no),
        selected.presentation,
        JSON.stringify({
          type: 'WORLD_CONSEQUENCE',
          decision_id: decisionId,
          decision_key: input.rule.decisionKey,
          outcome_key: selected.outcomeKey
        })
      ]
    );
    await database.query(
      `INSERT INTO character_decision (
         decision_id, world_id, character_id, decision_key, outcome_key,
         rationale, state_version, presentation_message_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        decisionId,
        input.worldId,
        input.characterId,
        input.rule.decisionKey,
        selected.outcomeKey,
        selected.rationale,
        Number(current.version),
        messageId
      ]
    );
    for (const factId of factIds) {
      await database.query(
        `INSERT INTO character_decision_fact (decision_id, fact_id)
         VALUES ($1, $2)`,
        [decisionId, factId]
      );
    }
    await database.query(
      `UPDATE chat_conversation
       SET next_sequence_no = $2, last_message_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE conversation_id = $1`,
      [input.conversationId, Number(activeConversation.next_sequence_no) + 1]
    );
    await database.exec('COMMIT');
  } catch (error) {
    await database.exec('ROLLBACK');
    throw error;
  }
  return { decisionId, outcomeKey: selected.outcomeKey, factIds };
}
