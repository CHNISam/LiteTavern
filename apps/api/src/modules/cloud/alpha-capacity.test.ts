import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { createBatch, releaseUsers } from './batches.js';
import { loadCloudConfig, type CloudConfig } from './config.js';
import {
  countOutstandingFeedback,
  recordBlocker,
  submitFeedback,
  transitionBlocker,
  triageFeedback
} from './feedback.js';
import {
  activateAlpha,
  ensureMembership,
  grantAlpha,
  joinWaitlist,
  listWaitlist,
  readBatchPolicy,
  transitionAlpha
} from './membership.js';
import {
  getPlan,
  getSeatUsage,
  listCapacityAudit,
  reclaimSeat,
  unlockBatchTwo
} from './plan.js';
import {
  confirmReadiness,
  consecutiveStableSessions,
  effectiveTesters,
  evaluateReadiness
} from './readiness.js';
import { markFoundingSupporter } from './supporter.js';
import { initializeFreeQuota } from '../free-quota.js';

let database: PomChatDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return { ...loadCloudConfig({}), ...overrides };
}

async function setup() {
  database = await createDatabase({ dataDir: 'memory://' });
  return database;
}

async function createUser(db: PomChatDatabase): Promise<string> {
  const userId = randomUUID();
  await db.query(`INSERT INTO app_user (user_id, email) VALUES ($1, $2)`, [
    userId,
    `${userId}@example.com`
  ]);
  await initializeFreeQuota(db, userId, 30);
  await ensureMembership(db, userId, false);
  await joinWaitlist(db, userId);
  return userId;
}

/** A wave-1 batch big enough that the program ceiling is the only binding limit. */
async function wave1Batch(db: PomChatDatabase, cloud: CloudConfig, capacity = 30) {
  const batch = await createBatch(db, cloud, { name: 'wave-1', capacity });
  await db.query(`UPDATE alpha_batch SET batch_no = 1 WHERE batch_id = $1`, [
    batch.batch_id
  ]);
  return batch;
}

async function createCharacter(db: PomChatDatabase): Promise<string> {
  const characterId = randomUUID();
  await db.query(
    `INSERT INTO agent_character (character_id, name, status)
     VALUES ($1, 'tester', 'ACTIVE')`,
    [characterId]
  );
  return characterId;
}

/**
 * Fabricates one complete core session: a persisted user message, a completed
 * platform generation, a persisted assistant reply, a finalized Alpha cost row and a
 * quota CONSUME entry. `omit` drops exactly one of those parts so a test can prove
 * that an incomplete session is not counted.
 */
async function completeCoreSession(
  db: PomChatDatabase,
  input: {
    userId: string;
    characterId: string;
    conversationId?: string;
    sessionId?: string;
    priorMessageIds?: string[];
    omit?: 'usage' | 'quota' | 'assistant';
  }
): Promise<{ conversationId: string; assistantMessageId: string }> {
  const conversationId = input.conversationId ?? randomUUID();
  if (!input.conversationId) {
    await db.query(
      `INSERT INTO chat_conversation (conversation_id, user_id, character_id)
       VALUES ($1, $2, $3)`,
      [conversationId, input.userId, input.characterId]
    );
  }

  const seq = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next
     FROM chat_message WHERE conversation_id = $1`,
    [conversationId]
  );
  const base = Number(seq.rows[0]?.next ?? 1);

  const userMessageId = randomUUID();
  await db.query(
    `INSERT INTO chat_message (
       message_id, conversation_id, sequence_no, turn_no, role, content_text, status
     ) VALUES ($1, $2, $3, $4, 'USER', 'hi', 'COMPLETED')`,
    [userMessageId, conversationId, base, base]
  );

  const requestId = randomUUID();
  const idempotencyKey = `key-${requestId}`;
  await db.query(
    `INSERT INTO agent_generation_request (
       generation_request_id, user_id, conversation_id, input_message_id,
       usage_mode, idempotency_key, status, prompt_version, provider, model_name,
       client_session_id, completed_at, context_manifest_json
     ) VALUES (
       $1, $2, $3, $4, 'PLATFORM', $5, 'COMPLETED', 'test', 'groq', 'm',
       $6, CURRENT_TIMESTAMP, $7::jsonb
     )`,
    [
      requestId,
      input.userId,
      conversationId,
      userMessageId,
      idempotencyKey,
      input.sessionId ?? randomUUID(),
      JSON.stringify({
        prompt_version: 'test',
        message_ids: input.priorMessageIds ?? [],
        memory_ids: []
      })
    ]
  );

  const assistantMessageId = randomUUID();
  if (input.omit !== 'assistant') {
    await db.query(
      `INSERT INTO chat_message (
         message_id, conversation_id, generation_request_id, sequence_no, turn_no,
         role, content_text, status
       ) VALUES ($1, $2, $3, $4, $5, 'ASSISTANT', 'hello', 'COMPLETED')`,
      [assistantMessageId, conversationId, requestId, base + 1, base]
    );
  }

  const cycle = await db.query<{ cycle_id: string }>(
    `SELECT cycle_id FROM cloud_quota_cycle
     WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [input.userId]
  );
  const cycleId = cycle.rows[0]?.cycle_id;

  if (input.omit !== 'quota' && cycleId) {
    await db.query(
      `INSERT INTO cloud_quota_ledger (
         quota_ledger_id, cycle_id, user_id, request_id, action_type,
         units, balance_after, provider, model
       ) VALUES ($1, $2, $3, $4, 'CONSUME', 1, 0, 'groq', 'm')`,
      [randomUUID(), cycleId, input.userId, idempotencyKey]
    );
  }

  if (input.omit !== 'usage') {
    await db.query(
      `INSERT INTO model_usage_ledger (
         usage_id, generation_request_id, user_id, usage_mode, provider, model_name,
         status, input_tokens, output_tokens, quota_source, quota_units,
         cycle_id, purpose, actual_cost_usd, finalized_at
       ) VALUES (
         $1, $2, $3, 'PLATFORM', 'groq', 'm', 'FINALIZED', 100, 100,
         'ALPHA', 1, $4, 'MAIN_REPLY', 0.01, CURRENT_TIMESTAMP
       )`,
      [randomUUID(), requestId, input.userId, cycleId ?? null]
    );
  }

  return { conversationId, assistantMessageId };
}

/** A user who has genuinely completed the ten-step core journey. */
async function makeEffectiveTester(
  db: PomChatDatabase,
  cloud: CloudConfig,
  batchId: string
): Promise<string> {
  const userId = await createUser(db);
  await releaseUsers(db, cloud, { batchId, userIds: [userId] });
  await activateAlpha(db, {
    userId,
    policy: await readBatchPolicy(db, batchId, cloud.defaultAlphaPolicy)
  });
  const characterId = await createCharacter(db);

  // First visit.
  const first = await completeCoreSession(db, {
    userId,
    characterId,
    sessionId: `s1-${userId}`
  });
  // Return visit: a different client session, same character, and a prompt that
  // actually carried the earlier conversation forward.
  await completeCoreSession(db, {
    userId,
    characterId,
    conversationId: first.conversationId,
    sessionId: `s2-${userId}`,
    priorMessageIds: [first.assistantMessageId]
  });
  return userId;
}

describe('alpha capacity plan', () => {
  it('seeds the v0.1.0 plan with 30 total, 10 released and wave 2 locked', async () => {
    const db = await setup();
    const plan = await getPlan(db);

    expect(plan.total_capacity).toBe(30);
    expect(plan.batch_1_capacity).toBe(10);
    expect(plan.batch_2_capacity).toBe(20);
    expect(plan.released_capacity).toBe(10);
    expect(plan.batch_2_unlocked).toBe(false);
  });

  it('issues exactly 10 seats and rejects the 11th', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const users: string[] = [];
    for (let index = 0; index < 11; index += 1) users.push(await createUser(db));

    const release = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: users
    });

    expect(release.granted).toHaveLength(10);
    expect(release.skipped).toHaveLength(1);
    expect(release.skipped[0]?.reason).toBe('PROGRAM_CAPACITY_EXHAUSTED');

    const seats = await getSeatUsage(db);
    expect(seats.assigned).toBe(10);
    expect(seats.remaining).toBe(0);
  });

  it('does not oversell when releases run concurrently', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const policy = await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy);
    const users: string[] = [];
    for (let index = 0; index < 16; index += 1) users.push(await createUser(db));

    // Sixteen releases issued together against ten seats.
    const results = await Promise.all(
      users.map((userId) =>
        grantAlpha(db, {
          userId,
          batchId: batch.batch_id,
          grantSource: 'ADMIN_GRANT',
          policy
        })
      )
    );

    expect(results.filter((result) => result.granted)).toHaveLength(10);
    const live = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM alpha_grant WHERE status = 'GRANTED'`
    );
    expect(live.rows[0]?.count).toBe(10);
  });

  it('frees a seat on reclaim and lets it be re-issued within wave 1', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const users: string[] = [];
    for (let index = 0; index < 10; index += 1) users.push(await createUser(db));
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: users });

    const replacement = await createUser(db);
    const rejected = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: [replacement]
    });
    expect(rejected.granted).toHaveLength(0);

    const first = users[0] as string;
    const reclaimed = await reclaimSeat(db, {
      userId: first,
      actor: 'admin',
      reason: '长期未激活'
    });
    expect(reclaimed.reclaimed).toBe(true);

    const retry = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: [replacement]
    });
    expect(retry.granted).toEqual([replacement]);

    // Re-issuing a reclaimed seat is still wave 1: it must not open wave 2.
    const plan = await getPlan(db);
    expect(plan.batch_2_unlocked).toBe(false);
    expect(plan.released_capacity).toBe(10);
    const seats = await getSeatUsage(db);
    expect(seats.assigned).toBe(10);

    const audit = await listCapacityAudit(db, { userId: first });
    expect(audit.some((entry) => entry.action === 'RECLAIM')).toBe(true);
  });

  it('allows up to 30 seats once wave 2 is unlocked, and still refuses the 31st', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud, 40);
    const users: string[] = [];
    for (let index = 0; index < 31; index += 1) users.push(await createUser(db));

    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: users });
    expect((await getSeatUsage(db)).assigned).toBe(10);

    await unlockBatchTwo(db, { actor: 'admin', evidence: { test: true } });
    expect((await getPlan(db)).released_capacity).toBe(30);

    const second = await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: users
    });
    expect(second.granted).toHaveLength(20);

    const seats = await getSeatUsage(db);
    expect(seats.assigned).toBe(30);
    expect(seats.remaining).toBe(0);
    expect(
      second.skipped.some(
        (item) => item.reason === 'PROGRAM_CAPACITY_EXHAUSTED'
      )
    ).toBe(true);
  });
});

describe('alpha waitlist ordering', () => {
  it('puts Founding Supporters first and orders each tier by application time', async () => {
    const db = await setup();
    const early = await createUser(db);
    const middle = await createUser(db);
    const supporter = await createUser(db);
    await markFoundingSupporter(db, { userId: supporter, anonymous: true });

    const ordered = await listWaitlist(db);

    expect(ordered[0]?.userId).toBe(supporter);
    expect(ordered[0]?.foundingSupporter).toBe(true);
    expect(ordered[0]?.rank).toBe(1);
    // Within the ordinary tier, whoever applied first comes first.
    expect(ordered[1]?.userId).toBe(early);
    expect(ordered[2]?.userId).toBe(middle);
  });

  it('never grants a Founding Supporter Alpha automatically', async () => {
    const db = await setup();
    const supporter = await createUser(db);
    await markFoundingSupporter(db, { userId: supporter, anonymous: true });

    const membership = await ensureMembership(db, supporter, true);

    expect(membership.status).toBe('REGISTERED_WAITLIST');
    const grants = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM alpha_grant WHERE user_id = $1`,
      [supporter]
    );
    expect(grants.rows[0]?.count).toBe(0);
  });

  it('records an audit entry for a hand-picked release', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const picked = await createUser(db);

    await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: [picked],
      grantedBy: 'operator-jane'
    });

    const audit = await listCapacityAudit(db, { userId: picked });
    const grant = audit.find((entry) => entry.action === 'GRANT');
    expect(grant?.actor).toBe('operator-jane');
    expect(grant?.detail.grant_source).toBe('DIRECT_INVITE');
  });
});

describe('effective testers and stable core sessions', () => {
  it('counts only users who completed the whole core journey', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);

    const complete = await makeEffectiveTester(db, cloud, batch.batch_id);

    // Holds a seat and never chatted.
    const idle = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [idle] });
    await activateAlpha(db, {
      userId: idle,
      policy: await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy)
    });

    // Chatted once and never came back.
    const oneShot = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [oneShot] });
    await activateAlpha(db, {
      userId: oneShot,
      policy: await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy)
    });
    await completeCoreSession(db, {
      userId: oneShot,
      characterId: await createCharacter(db),
      sessionId: 'single'
    });

    // Granted a seat but never entered.
    const neverEntered = await createUser(db);
    await releaseUsers(db, cloud, {
      batchId: batch.batch_id,
      userIds: [neverEntered]
    });

    const testers = await effectiveTesters(db, 1);
    const effective = testers.filter((tester) => tester.effective);

    expect(effective.map((tester) => tester.user_id)).toEqual([complete]);
    expect(testers.find((t) => t.user_id === idle)?.chatted).toBe(false);
    expect(testers.find((t) => t.user_id === oneShot)?.returned).toBe(false);
    expect(testers.find((t) => t.user_id === neverEntered)?.activated).toBe(false);
  });

  it('ignores a session that is missing its cost or quota record', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const userId = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });
    await activateAlpha(db, {
      userId,
      policy: await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy)
    });
    const characterId = await createCharacter(db);

    await completeCoreSession(db, { userId, characterId, omit: 'usage' });
    await completeCoreSession(db, { userId, characterId, omit: 'quota' });
    await completeCoreSession(db, { userId, characterId, omit: 'assistant' });

    expect((await consecutiveStableSessions(db)).totalCoreSessions).toBe(0);

    await completeCoreSession(db, { userId, characterId });
    expect((await consecutiveStableSessions(db)).totalCoreSessions).toBe(1);
  });

  it('restarts the consecutive count when a blocker occurs, including a recurrence', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const userId = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });
    await activateAlpha(db, {
      userId,
      policy: await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy)
    });
    const characterId = await createCharacter(db);

    for (let index = 0; index < 3; index += 1) {
      await completeCoreSession(db, { userId, characterId });
    }
    expect((await consecutiveStableSessions(db)).count).toBe(3);

    const blocker = await recordBlocker(db, {
      blockerType: 'CHAT_UNAVAILABLE',
      title: '核心聊天不可用'
    });
    expect((await consecutiveStableSessions(db)).count).toBe(0);

    for (let index = 0; index < 2; index += 1) {
      await completeCoreSession(db, { userId, characterId });
    }
    expect((await consecutiveStableSessions(db)).count).toBe(2);

    // Closing it does not rewind the clock...
    await transitionBlocker(db, { blockerId: blocker.blocker_id, transition: 'RESOLVE', actor: 'a' });
    await transitionBlocker(db, { blockerId: blocker.blocker_id, transition: 'VERIFY', actor: 'a' });
    await transitionBlocker(db, { blockerId: blocker.blocker_id, transition: 'CLOSE', actor: 'a' });
    expect((await consecutiveStableSessions(db)).count).toBe(2);

    // ...but the same issue coming back counts as a fresh blocking failure.
    await recordBlocker(db, {
      blockerType: 'CHAT_UNAVAILABLE',
      title: '核心聊天不可用',
      recurrenceOf: blocker.blocker_id
    });
    expect((await consecutiveStableSessions(db)).count).toBe(0);
    const reopened = await db.query<{ status: string; recurrence_count: number }>(
      `SELECT status, recurrence_count FROM alpha_blocker WHERE blocker_id = $1`,
      [blocker.blocker_id]
    );
    expect(reopened.rows[0]?.status).toBe('OPEN');
    expect(Number(reopened.rows[0]?.recurrence_count)).toBe(1);
  });

  it('keeps counting through an ordinary non-blocking failure', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const userId = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });
    await activateAlpha(db, {
      userId,
      policy: await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy)
    });
    const characterId = await createCharacter(db);

    await completeCoreSession(db, { userId, characterId });
    // A failed request is recorded but is not a blocker.
    await db.query(
      `INSERT INTO agent_generation_request (
         generation_request_id, user_id, conversation_id, input_message_id,
         usage_mode, idempotency_key, status, prompt_version, error_code
       )
       SELECT $1, user_id, conversation_id, input_message_id, 'PLATFORM', $2,
              'FAILED', 'test', 'PROVIDER_TIMEOUT'
       FROM agent_generation_request LIMIT 1`,
      [randomUUID(), `fail-${randomUUID()}`]
    );
    await completeCoreSession(db, { userId, characterId });

    expect((await consecutiveStableSessions(db)).count).toBe(2);
  });
});

describe('batch 2 unlock gate', () => {
  /** Brings a fresh program to the point where every automatic gate passes. */
  async function readyProgram() {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);

    const testers: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      testers.push(await makeEffectiveTester(db, cloud, batch.batch_id));
    }
    // Five testers produced 10 core sessions; top up to the required 20.
    const character = await createCharacter(db);
    const first = testers[0] as string;
    for (let index = 0; index < 10; index += 1) {
      await completeCoreSession(db, { userId: first, characterId: character });
    }
    return { db, cloud, batch, testers };
  }

  it('passes every automatic check once the first wave is genuinely digested', async () => {
    const { db, cloud } = await readyProgram();
    const readiness = await evaluateReadiness(db, cloud);

    const failing = readiness.checks.filter((check) => !check.passed);
    // Only the operator confirmation remains, which cannot be computed.
    expect(failing.map((check) => check.key)).toEqual([
      'cost_and_capacity_confirmed'
    ]);
    expect(readiness.can_unlock).toBe(false);
  });

  it('refuses to unlock while feedback is unclassified or undisposed', async () => {
    const { db, cloud, testers } = await readyProgram();
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });

    const feedback = await submitFeedback(db, {
      userId: testers[0] as string,
      batchNo: 1,
      title: '角色头像偶尔不显示'
    });
    let readiness = await evaluateReadiness(db, cloud);
    expect(readiness.can_unlock).toBe(false);
    expect(readiness.checks.find((c) => c.key === 'feedback_disposed')?.passed).toBe(
      false
    );

    // Classified but still undecided: still outstanding.
    await triageFeedback(db, {
      feedbackId: feedback.feedback_id,
      category: 'UX',
      severity: 'MINOR',
      actor: 'admin'
    });
    readiness = await evaluateReadiness(db, cloud);
    expect(readiness.can_unlock).toBe(false);
    expect((await countOutstandingFeedback(db, 1)).undisposed).toBe(1);

    // A non-blocking issue may be deferred; that is a real conclusion.
    await triageFeedback(db, {
      feedbackId: feedback.feedback_id,
      disposition: 'DEFER',
      dispositionNote: '排入 v0.1.1',
      actor: 'admin'
    });
    readiness = await evaluateReadiness(db, cloud);
    expect(readiness.checks.find((c) => c.key === 'feedback_disposed')?.passed).toBe(
      true
    );
    expect(readiness.can_unlock).toBe(true);
  });

  it('treats a duplicate as settled through its canonical row', async () => {
    const { db, cloud, testers } = await readyProgram();
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });
    const original = await submitFeedback(db, {
      userId: testers[0] as string,
      batchNo: 1,
      title: '登录后额度显示错误'
    });
    const duplicate = await submitFeedback(db, {
      userId: testers[1] as string,
      batchNo: 1,
      title: '额度显示不对'
    });

    await triageFeedback(db, {
      feedbackId: original.feedback_id,
      category: 'BILLING_QUOTA',
      severity: 'MAJOR',
      disposition: 'FIX_NOW',
      actor: 'admin'
    });
    await triageFeedback(db, {
      feedbackId: duplicate.feedback_id,
      duplicateOfFeedbackId: original.feedback_id,
      actor: 'admin'
    });

    expect((await countOutstandingFeedback(db, 1)).outstanding).toBe(0);
    expect((await evaluateReadiness(db, cloud)).can_unlock).toBe(true);
  });

  it('refuses to unlock while a blocker is unresolved, and requires verification to close it', async () => {
    const { db, cloud } = await readyProgram();
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });
    const blocker = await recordBlocker(db, {
      blockerType: 'CROSS_USER_LEAK',
      title: '跨用户数据可见'
    });

    expect((await evaluateReadiness(db, cloud)).can_unlock).toBe(false);

    // Closing without verifying is refused.
    await expect(
      transitionBlocker(db, {
        blockerId: blocker.blocker_id,
        transition: 'CLOSE',
        actor: 'admin'
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await transitionBlocker(db, { blockerId: blocker.blocker_id, transition: 'RESOLVE', actor: 'a' });
    // Resolved is not closed: the gate still blocks.
    expect((await evaluateReadiness(db, cloud)).can_unlock).toBe(false);

    await transitionBlocker(db, { blockerId: blocker.blocker_id, transition: 'VERIFY', actor: 'a' });
    await transitionBlocker(db, { blockerId: blocker.blocker_id, transition: 'CLOSE', actor: 'a' });

    // The blocker occurrence reset the stability counter, so that gate now fails.
    const readiness = await evaluateReadiness(db, cloud);
    expect(readiness.checks.find((c) => c.key === 'no_unresolved_blockers')?.passed).toBe(true);
    expect(readiness.checks.find((c) => c.key === 'stable_core_sessions')?.passed).toBe(false);
    expect(readiness.can_unlock).toBe(false);
  });

  it('refuses to unlock with fewer than five effective testers', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    for (let index = 0; index < 4; index += 1) {
      await makeEffectiveTester(db, cloud, batch.batch_id);
    }
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });

    const readiness = await evaluateReadiness(db, cloud);
    const check = readiness.checks.find((c) => c.key === 'effective_testers');

    expect(check?.passed).toBe(false);
    expect(check?.actual).toBe(4);
    expect(check?.required).toBe(5);
    expect(readiness.can_unlock).toBe(false);
  });

  it('refuses to unlock with fewer than twenty stable core sessions', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    for (let index = 0; index < 5; index += 1) {
      await makeEffectiveTester(db, cloud, batch.batch_id);
    }
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });

    const readiness = await evaluateReadiness(db, cloud);
    const check = readiness.checks.find((c) => c.key === 'stable_core_sessions');

    // Five testers × two visits = ten sessions.
    expect(check?.actual).toBe(10);
    expect(check?.passed).toBe(false);
    expect(readiness.can_unlock).toBe(false);
  });

  it('refuses to unlock until the operator confirms cost and support capacity', async () => {
    const { db, cloud } = await readyProgram();

    let readiness = await evaluateReadiness(db, cloud);
    const check = readiness.checks.find((c) => c.key === 'cost_and_capacity_confirmed');
    expect(check?.passed).toBe(false);
    expect(check?.automatable).toBe(false);
    expect(readiness.can_unlock).toBe(false);

    const confirmation = await confirmReadiness(db, cloud, {
      actor: 'operator-mei',
      batchNo: 1,
      note: '成本与人工处理能力可控'
    });
    // The metrics the operator saw are frozen with the confirmation.
    expect(confirmation.confirmed_by).toBe('operator-mei');
    expect(confirmation.metrics_snapshot).toHaveProperty('batch_1_cost_usd');
    expect(confirmation.metrics_snapshot).toHaveProperty('effective_testers', 5);

    readiness = await evaluateReadiness(db, cloud);
    expect(readiness.can_unlock).toBe(true);
  });

  it('unlocks once every condition holds, and stores the evidence snapshot', async () => {
    const { db, cloud } = await readyProgram();
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });
    const readiness = await evaluateReadiness(db, cloud);
    expect(readiness.can_unlock).toBe(true);

    const result = await unlockBatchTwo(db, {
      actor: 'operator-mei',
      evidence: { checks: readiness.checks, metrics: readiness.metrics }
    });

    expect(result.unlocked).toBe(true);
    expect(result.plan.released_capacity).toBe(30);
    expect(result.plan.batch_2_unlocked).toBe(true);
    expect(result.plan.batch_2_unlocked_by).toBe('operator-mei');
    expect(result.plan.current_batch_no).toBe(2);

    const stored = await db.query<{ unlock_evidence_json: { metrics: unknown } }>(
      `SELECT unlock_evidence_json FROM alpha_program_plan WHERE plan_key = 'v0.1.0'`
    );
    expect(stored.rows[0]?.unlock_evidence_json.metrics).toBeTruthy();

    const audit = await listCapacityAudit(db);
    const entry = audit.find((item) => item.action === 'BATCH_2_UNLOCK');
    expect(entry?.actor).toBe('operator-mei');
    expect(entry?.detail.released_capacity_after).toBe(30);
  });

  it('is idempotent when the unlock is requested twice', async () => {
    const { db, cloud } = await readyProgram();
    await confirmReadiness(db, cloud, { actor: 'admin', batchNo: 1 });

    const first = await unlockBatchTwo(db, { actor: 'operator-a', evidence: {} });
    const second = await unlockBatchTwo(db, { actor: 'operator-b', evidence: {} });

    expect(first.unlocked).toBe(true);
    expect(second.unlocked).toBe(false);
    expect(second.already_unlocked).toBe(true);
    // The original decision keeps its attribution and timestamp.
    expect(second.plan.batch_2_unlocked_by).toBe('operator-a');
    expect(second.plan.batch_2_unlocked_at).toStrictEqual(
      first.plan.batch_2_unlocked_at
    );
    expect(second.plan.released_capacity).toBe(30);

    const audit = await listCapacityAudit(db);
    expect(audit.filter((item) => item.action === 'BATCH_2_UNLOCK')).toHaveLength(1);
  });
});

describe('alpha state transitions', () => {
  it('withdraws platform access the moment a seat is suspended, and restores it on resume', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const userId = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });
    const policy = await readBatchPolicy(db, batch.batch_id, cloud.defaultAlphaPolicy);
    await activateAlpha(db, { userId, policy });

    await transitionAlpha(db, userId, 'PAUSE', '疑似异常调用', 'admin');
    const paused = await ensureMembership(db, userId, true);
    expect(paused.status).toBe('ALPHA_PAUSED');
    expect(paused.revokedReason).toBe('疑似异常调用');
    // A suspended user may not re-enter by replaying the activation request.
    await expect(activateAlpha(db, { userId, policy })).rejects.toMatchObject({
      code: 'ALPHA_NOT_GRANTED'
    });

    await transitionAlpha(db, userId, 'RESUME', undefined, 'admin');
    expect((await ensureMembership(db, userId, true)).status).toBe('ALPHA_ACTIVE');
  });

  it('returns a resumed but never-entered user to ALPHA_GRANTED', async () => {
    const db = await setup();
    const cloud = config();
    const batch = await wave1Batch(db, cloud);
    const userId = await createUser(db);
    await releaseUsers(db, cloud, { batchId: batch.batch_id, userIds: [userId] });

    await transitionAlpha(db, userId, 'PAUSE', '待核实', 'admin');
    await transitionAlpha(db, userId, 'RESUME', undefined, 'admin');

    expect((await ensureMembership(db, userId, true)).status).toBe('ALPHA_GRANTED');
  });

  it('refuses activation to a user who was never granted a seat', async () => {
    const db = await setup();
    const cloud = config();
    const userId = await createUser(db);

    await expect(
      activateAlpha(db, { userId, policy: cloud.defaultAlphaPolicy })
    ).rejects.toMatchObject({ code: 'ALPHA_NOT_GRANTED' });
  });

  it('keeps repeated waitlist joins idempotent', async () => {
    const db = await setup();
    const userId = await createUser(db);
    const before = await ensureMembership(db, userId, true);

    const again = await joinWaitlist(db, userId, 'app');

    expect(again.joined).toBe(false);
    expect(again.membership.waitlistJoinedAt).toStrictEqual(before.waitlistJoinedAt);
  });
});
