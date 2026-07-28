import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import type { CloudConfig } from './config.js';
import {
  countOutstandingFeedback,
  countUnresolvedBlockers,
  lastBlockerOccurrence
} from './feedback.js';
import { DEFAULT_PLAN_KEY, getPlan, recordCapacityAudit } from './plan.js';

/**
 * The wave-2 readiness checklist.
 *
 * Four of the five conditions are computed from facts the product already records —
 * membership rows, chat messages, generation requests, the quota ledger and the cost
 * ledger. None of them is an operator checkbox, because a checkbox would only record
 * that somebody believed the condition held.
 *
 * The fifth is the opposite: whether spend and support load are manageable cannot be
 * derived from this database, so it is an explicit operator confirmation with the
 * metrics they saw frozen alongside it. Presenting a guess there would be worse than
 * asking.
 *
 * Where the product cannot yet witness something, the check reports
 * `automatable: false` and fails rather than assuming success.
 */

export const REQUIRED_EFFECTIVE_TESTERS = 5;
export const REQUIRED_STABLE_SESSIONS = 20;

export interface CheckResult {
  key: string;
  label: string;
  passed: boolean;
  /** What the system measured. */
  actual: number | string;
  /** What it has to be. */
  required: number | string;
  /** Where the number came from, so a reviewer can re-derive it. */
  evidence: string;
  /** False when the product cannot witness this yet; such a check never passes. */
  automatable: boolean;
  /** Human-readable reason, present only when the check failed. */
  reason?: string;
}

/**
 * The ten steps of the core Alpha journey, each expressed as something the database
 * can actually answer. A user is an *effective tester* only when all ten hold.
 *
 * Steps 8–10 are the ones that distinguish "tried it once" from "came back and the
 * product remembered": the return visit is a second client session, the continuity
 * check reads the stored context manifest of that later request and requires it to
 * have actually loaded earlier messages or memories for the same character.
 */
const EFFECTIVE_TESTER_SQL = `
WITH seat AS (
  SELECT m.user_id, m.batch_id, m.activated_at,
         u.email IS NOT NULL AS registered
  FROM cloud_membership m
  JOIN app_user u ON u.user_id = m.user_id
  JOIN alpha_grant g ON g.user_id = m.user_id
  WHERE g.status = 'GRANTED'
    AND ($1::int IS NULL OR g.batch_no = $1::int)
),
-- One row per Alpha-paid, fully persisted, fully accounted model reply.
core_reply AS (
  SELECT r.user_id,
         r.generation_request_id,
         c.character_id,
         r.client_session_id,
         r.completed_at,
         r.context_manifest_json
  FROM agent_generation_request r
  JOIN chat_conversation c ON c.conversation_id = r.conversation_id
  JOIN chat_message am
    ON am.generation_request_id = r.generation_request_id
   AND am.role = 'ASSISTANT'
   AND am.status = 'COMPLETED'
  JOIN model_usage_ledger l
    ON l.generation_request_id = r.generation_request_id
   AND l.purpose = 'MAIN_REPLY'
   AND l.quota_source = 'ALPHA'
   AND l.status = 'FINALIZED'
  -- The quota ledger is keyed on the request's idempotency key, which is what the
  -- platform gate passes as its request id; (user_id, idempotency_key) is unique.
  JOIN cloud_quota_ledger q
    ON q.request_id = r.idempotency_key
   AND q.action_type = 'CONSUME'
   AND q.user_id = r.user_id
  WHERE r.status = 'COMPLETED'
    AND r.usage_mode = 'PLATFORM'
    AND EXISTS (
      SELECT 1 FROM chat_message um
      WHERE um.conversation_id = r.conversation_id
        AND um.role = 'USER'
        AND um.status = 'COMPLETED'
    )
),
-- Step 9 + 10: for the same character, a later session whose prompt actually
-- carried earlier history or recalled memory forward.
continuity AS (
  SELECT DISTINCT later.user_id
  FROM core_reply later
  JOIN core_reply earlier
    ON earlier.user_id = later.user_id
   AND earlier.character_id = later.character_id
   AND earlier.completed_at < later.completed_at
   AND earlier.client_session_id IS DISTINCT FROM later.client_session_id
  WHERE COALESCE(
          jsonb_array_length(later.context_manifest_json -> 'message_ids'), 0
        ) > 0
     OR COALESCE(
          jsonb_array_length(later.context_manifest_json -> 'memory_ids'), 0
        ) > 0
)
SELECT s.user_id,
       s.registered,
       s.activated_at IS NOT NULL AS activated,
       EXISTS (
         SELECT 1 FROM chat_conversation cc WHERE cc.user_id = s.user_id
       ) AS picked_character,
       EXISTS (
         SELECT 1 FROM core_reply cr WHERE cr.user_id = s.user_id
       ) AS chatted,
       COALESCE((
         SELECT COUNT(DISTINCT cr.client_session_id)::int
         FROM core_reply cr WHERE cr.user_id = s.user_id
       ), 0) AS sessions,
       EXISTS (
         SELECT 1 FROM continuity k WHERE k.user_id = s.user_id
       ) AS continuity_verified
FROM seat s`;

export interface EffectiveTesterBreakdown {
  user_id: string;
  registered: boolean;
  activated: boolean;
  picked_character: boolean;
  chatted: boolean;
  returned: boolean;
  continuity_verified: boolean;
  effective: boolean;
}

/**
 * Which seat-holders have genuinely completed the core journey.
 *
 * Holding a grant is explicitly not enough: a user who was released and never chatted
 * fails at `chatted`, and one who chatted only in a single sitting fails at
 * `returned`. That gap between "seats issued" and "testers proven" is the whole
 * reason the count is computed rather than asserted.
 */
export async function effectiveTesters(
  database: PomChatDatabase,
  batchNo?: number
): Promise<EffectiveTesterBreakdown[]> {
  const result = await database.query<{
    user_id: string;
    registered: boolean;
    activated: boolean;
    picked_character: boolean;
    chatted: boolean;
    sessions: number;
    continuity_verified: boolean;
  }>(EFFECTIVE_TESTER_SQL, [batchNo ?? null]);

  return result.rows.map((row) => {
    const returned = Number(row.sessions) >= 2;
    return {
      user_id: row.user_id,
      registered: row.registered,
      activated: row.activated,
      picked_character: row.picked_character,
      chatted: row.chatted,
      returned,
      continuity_verified: row.continuity_verified,
      effective:
        row.registered &&
        row.activated &&
        row.picked_character &&
        row.chatted &&
        returned &&
        row.continuity_verified
    };
  });
}

/**
 * A *core session* is one completed Alpha reply that satisfies every part of the
 * definition at once: the user sent a real message, the model replied, the reply was
 * persisted, quota was consumed and the cost was booked. A request missing any of
 * those is not counted — which is what stops a half-failed turn from inflating the
 * stability record.
 *
 * The consecutive count is simply the number of such sessions completed *after* the
 * most recent blocker occurrence. Because a recurrence moves that timestamp forward,
 * the counter resets on its own, and an ordinary non-blocking error leaves it alone
 * while still being recorded in the request and ledger rows.
 */
export async function consecutiveStableSessions(
  database: PomChatDatabase
): Promise<{ count: number; since: string | null; totalCoreSessions: number }> {
  const since = await lastBlockerOccurrence(database);

  const result = await database.query<{ total: number; recent: number }>(
    `WITH core_session AS (
       SELECT r.completed_at
       FROM agent_generation_request r
       JOIN chat_message am
         ON am.generation_request_id = r.generation_request_id
        AND am.role = 'ASSISTANT'
        AND am.status = 'COMPLETED'
       JOIN model_usage_ledger l
         ON l.generation_request_id = r.generation_request_id
        AND l.purpose = 'MAIN_REPLY'
        AND l.quota_source = 'ALPHA'
        AND l.status = 'FINALIZED'
       JOIN cloud_quota_ledger q
         ON q.request_id = r.idempotency_key
        AND q.action_type = 'CONSUME'
        AND q.user_id = r.user_id
       WHERE r.status = 'COMPLETED'
         AND r.usage_mode = 'PLATFORM'
         AND r.completed_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM chat_message um
           WHERE um.conversation_id = r.conversation_id
             AND um.role = 'USER'
             AND um.status = 'COMPLETED'
         )
     )
     SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE $1::timestamptz IS NULL OR completed_at > $1::timestamptz
            )::int AS recent
     FROM core_session`,
    [since]
  );

  const row = result.rows[0];
  return {
    count: Number(row?.recent ?? 0),
    since,
    totalCoreSessions: Number(row?.total ?? 0)
  };
}

export interface OperationalMetrics {
  batch_1_cost_usd: number;
  effective_testers: number;
  average_cost_per_effective_tester_usd: number;
  recent_model_failure_rate: number;
  recent_model_requests: number;
  provider_incidents: { provider: string; failures: number; rate_limited: number }[];
  outstanding_feedback: number;
  unresolved_blockers: number;
}

/**
 * The numbers an operator has to look at before confirming. Everything here comes
 * from the existing cost and generation tables; nothing is re-stored for reporting.
 *
 * The failure rate and provider incidents cover a trailing window rather than all
 * time, because "is it healthy now" is the question being asked.
 */
export async function operationalMetrics(
  database: PomChatDatabase,
  options: { batchNo?: number; windowHours?: number } = {}
): Promise<OperationalMetrics> {
  const windowHours = options.windowHours ?? 24 * 7;
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const cost = await database.query<{ total: string | number | null }>(
    `SELECT COALESCE(SUM(l.actual_cost_usd), 0) AS total
     FROM model_usage_ledger l
     WHERE l.quota_source = 'ALPHA'
       AND l.status <> 'REVERSED'
       AND ($1::int IS NULL OR EXISTS (
         SELECT 1 FROM alpha_grant g
         WHERE g.user_id = l.user_id AND g.batch_no = $1::int
       ))`,
    [options.batchNo ?? null]
  );

  const failures = await database.query<{ total: number; failed: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
     FROM agent_generation_request
     WHERE usage_mode = 'PLATFORM' AND created_at >= $1`,
    [since]
  );

  // Provider health from the attempt log the generation path already writes.
  const providers = await database.query<{
    provider: string;
    failures: number;
    rate_limited: number;
  }>(
    `SELECT COALESCE(provider, 'unknown') AS provider,
            COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failures,
            COUNT(*) FILTER (
              WHERE error_code ILIKE '%RATE%' OR error_code ILIKE '%429%'
                 OR error_code ILIKE '%QUOTA%'
            )::int AS rate_limited
     FROM agent_generation_request
     WHERE usage_mode = 'PLATFORM' AND created_at >= $1
     GROUP BY COALESCE(provider, 'unknown')
     HAVING COUNT(*) FILTER (WHERE status = 'FAILED') > 0
     ORDER BY 2 DESC`,
    [since]
  );

  const testers = await effectiveTesters(database, options.batchNo);
  const effective = testers.filter((tester) => tester.effective).length;
  const totalCost = Number(cost.rows[0]?.total ?? 0);
  const feedback = await countOutstandingFeedback(database, options.batchNo);
  const totalRequests = Number(failures.rows[0]?.total ?? 0);

  return {
    batch_1_cost_usd: Math.round(totalCost * 1e8) / 1e8,
    effective_testers: effective,
    average_cost_per_effective_tester_usd:
      effective === 0 ? 0 : Math.round((totalCost / effective) * 1e8) / 1e8,
    recent_model_failure_rate:
      totalRequests === 0
        ? 0
        : Math.round((Number(failures.rows[0]?.failed ?? 0) / totalRequests) * 1e4) /
          1e4,
    recent_model_requests: totalRequests,
    provider_incidents: providers.rows.map((row) => ({
      provider: row.provider,
      failures: Number(row.failures),
      rate_limited: Number(row.rate_limited)
    })),
    outstanding_feedback: feedback.outstanding,
    unresolved_blockers: await countUnresolvedBlockers(database)
  };
}

export interface ReadinessConfirmation {
  confirmation_id: string;
  confirmed_by: string;
  confirmed_at: string;
  note: string | null;
  metrics_snapshot: Record<string, unknown>;
}

/** The current, non-superseded operator confirmation for a wave, if any. */
export async function currentConfirmation(
  database: PomChatDatabase,
  batchNo: number,
  planKey = DEFAULT_PLAN_KEY
): Promise<ReadinessConfirmation | null> {
  const result = await database.query<{
    confirmation_id: string;
    confirmed_by: string;
    confirmed_at: string;
    note: string | null;
    metrics_snapshot_json: Record<string, unknown>;
  }>(
    `SELECT confirmation_id, confirmed_by, confirmed_at, note, metrics_snapshot_json
     FROM alpha_readiness_confirmation
     WHERE plan_key = $1 AND batch_no = $2 AND superseded_at IS NULL
     ORDER BY confirmed_at DESC
     LIMIT 1`,
    [planKey, batchNo]
  );
  const row = result.rows[0];
  return row
    ? {
        confirmation_id: row.confirmation_id,
        confirmed_by: row.confirmed_by,
        confirmed_at: row.confirmed_at,
        note: row.note,
        metrics_snapshot: row.metrics_snapshot_json
      }
    : null;
}

/**
 * Records the operator's judgement that spend and support load are manageable,
 * freezing the metrics they were shown. Any earlier confirmation for the same wave is
 * superseded, so "confirmed" always refers to one specific set of numbers.
 */
export async function confirmReadiness(
  database: PomChatDatabase,
  config: CloudConfig,
  input: { actor: string; note?: string; batchNo: number; planKey?: string }
): Promise<ReadinessConfirmation> {
  const planKey = input.planKey ?? DEFAULT_PLAN_KEY;
  const metrics = await operationalMetrics(database, { batchNo: input.batchNo });
  const snapshot = {
    ...metrics,
    global_monthly_budget_usd: config.globalMonthlyBudgetUsd,
    captured_at: new Date().toISOString()
  };
  const confirmationId = randomUUID();

  await database.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE alpha_readiness_confirmation
       SET superseded_at = CURRENT_TIMESTAMP
       WHERE plan_key = $1 AND batch_no = $2 AND superseded_at IS NULL`,
      [planKey, input.batchNo]
    );
    await transaction.query(
      `INSERT INTO alpha_readiness_confirmation (
         confirmation_id, plan_key, batch_no, confirmed_by, note,
         metrics_snapshot_json
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        confirmationId,
        planKey,
        input.batchNo,
        input.actor,
        input.note ?? null,
        JSON.stringify(snapshot)
      ]
    );
    await recordCapacityAudit(transaction, {
      planKey,
      action: 'READINESS_CONFIRMED',
      actor: input.actor,
      batchNo: input.batchNo,
      reason: input.note ?? null,
      detail: { confirmation_id: confirmationId, metrics: snapshot }
    });
  });

  const created = await currentConfirmation(database, input.batchNo, planKey);
  if (!created) {
    throw new Error('readiness confirmation was not persisted');
  }
  return created;
}

export interface ReadinessReport {
  plan_key: string;
  batch_no: number;
  /** True only when every check below passed. */
  can_unlock: boolean;
  already_unlocked: boolean;
  checks: CheckResult[];
  metrics: OperationalMetrics;
  confirmation: ReadinessConfirmation | null;
  /** Empty when `can_unlock` is true. */
  blocking_reasons: string[];
}

/**
 * Evaluates all five gates. This is the single implementation used both by the
 * operator's checklist view and by the unlock endpoint, so what an operator sees is
 * by construction what the server will re-check when they press the button.
 */
export async function evaluateReadiness(
  database: PomChatDatabase,
  config: CloudConfig,
  options: { planKey?: string } = {}
): Promise<ReadinessReport> {
  const planKey = options.planKey ?? DEFAULT_PLAN_KEY;
  const plan = await getPlan(database, planKey);
  const batchNo = 1;

  const feedback = await countOutstandingFeedback(database, batchNo);
  const unresolvedBlockers = await countUnresolvedBlockers(database);
  const testers = await effectiveTesters(database, batchNo);
  const effective = testers.filter((tester) => tester.effective).length;
  const stable = await consecutiveStableSessions(database);
  const metrics = await operationalMetrics(database, { batchNo });
  const confirmation = await currentConfirmation(database, batchNo, planKey);

  const checks: CheckResult[] = [
    {
      key: 'feedback_disposed',
      label: '第一批有效反馈全部完成分类和处置',
      passed: feedback.outstanding === 0,
      actual: feedback.outstanding,
      required: 0,
      evidence: `alpha_feedback：共 ${feedback.total} 条，未分类 ${feedback.unclassified} 条，无处置结论 ${feedback.undisposed} 条（重复项与无效项不计）`,
      automatable: true,
      ...(feedback.outstanding === 0
        ? {}
        : {
            reason: `仍有 ${feedback.outstanding} 条有效反馈未完成分类或未给出处置结论。`
          })
    },
    {
      key: 'no_unresolved_blockers',
      label: '未解决阻断问题为 0',
      passed: unresolvedBlockers === 0,
      actual: unresolvedBlockers,
      required: 0,
      evidence: 'alpha_blocker：status <> CLOSED 的记录数（关闭需先修复并验证）',
      automatable: true,
      ...(unresolvedBlockers === 0
        ? {}
        : { reason: `仍有 ${unresolvedBlockers} 个阻断问题未修复、未验证或未关闭。` })
    },
    {
      key: 'effective_testers',
      label: `至少 ${REQUIRED_EFFECTIVE_TESTERS} 名有效测试者跑通核心路径`,
      passed: effective >= REQUIRED_EFFECTIVE_TESTERS,
      actual: effective,
      required: REQUIRED_EFFECTIVE_TESTERS,
      evidence: `依据 cloud_membership、alpha_grant、chat_message、agent_generation_request、cloud_quota_ledger、model_usage_ledger 与 context_manifest_json 自动计算；当前持有席位 ${testers.length} 人`,
      automatable: true,
      ...(effective >= REQUIRED_EFFECTIVE_TESTERS
        ? {}
        : {
            reason: `当前有效测试者 ${effective} 名，少于要求的 ${REQUIRED_EFFECTIVE_TESTERS} 名（仅领取资格不计入）。`
          })
    },
    {
      key: 'stable_core_sessions',
      label: `连续 ${REQUIRED_STABLE_SESSIONS} 次核心会话无新增阻断故障`,
      passed: stable.count >= REQUIRED_STABLE_SESSIONS,
      actual: stable.count,
      required: REQUIRED_STABLE_SESSIONS,
      evidence: stable.since
        ? `自最近一次阻断故障（${stable.since}）以来的合格核心会话数；历史累计 ${stable.totalCoreSessions} 次`
        : `尚无阻断故障记录，统计全部合格核心会话；历史累计 ${stable.totalCoreSessions} 次`,
      automatable: true,
      ...(stable.count >= REQUIRED_STABLE_SESSIONS
        ? {}
        : {
            reason: `自最近一次阻断故障以来仅有 ${stable.count} 次合格核心会话，少于要求的 ${REQUIRED_STABLE_SESSIONS} 次。`
          })
    },
    {
      key: 'cost_and_capacity_confirmed',
      label: '管理员已确认当前成本与人工处理能力可控',
      passed: confirmation !== null,
      actual: confirmation ? `${confirmation.confirmed_by} @ ${confirmation.confirmed_at}` : '未确认',
      required: '需要管理员显式确认',
      evidence:
        '成本、Provider 与积压指标由系统客观展示；「是否可控」无法从现有数据客观判定，因此保留为管理员显式确认并快照当时指标',
      automatable: false,
      ...(confirmation
        ? {}
        : {
            reason: '管理员尚未确认当前成本、Provider 状态与反馈积压可控。'
          })
    }
  ];

  const blockingReasons = checks
    .filter((check) => !check.passed)
    .map((check) => check.reason ?? `${check.label} 未通过。`);

  return {
    plan_key: planKey,
    batch_no: batchNo,
    can_unlock: blockingReasons.length === 0,
    already_unlocked: plan.batch_2_unlocked,
    checks,
    metrics,
    confirmation,
    blocking_reasons: blockingReasons
  };
}
