import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import type { CloudConfig, ModelPrice } from './config.js';
import type { QuotaSource } from './quota.js';

/**
 * Real-cost accounting for LiteTavern Cloud.
 *
 * Quota units are what the user sees; money is what the operator has to plan around.
 * Every platform-paid model call writes one row per purpose into model_usage_ledger
 * with the tokens it burned and the USD it cost, which is what makes per-user and
 * per-batch cost, and the global budget breaker, computable from data rather than
 * guessed.
 */

export type UsagePurpose =
  | 'MAIN_REPLY'
  | 'SUMMARY'
  | 'MEMORY'
  | 'RELATIONSHIP'
  | 'SUGGESTION'
  | 'OTHER';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Only some providers report cached input separately. */
  cachedInputTokens?: number;
}

const ZERO_PRICE: ModelPrice = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cachedInputPerMillion: 0
};

export function priceFor(
  prices: Record<string, ModelPrice>,
  provider: string,
  model: string
): ModelPrice {
  return prices[`${provider}:${model}`] ?? prices[model] ?? ZERO_PRICE;
}

/**
 * USD for one call. Unpriced models yield 0 — an honest "not measured" rather than a
 * fabricated figure; configure CLOUD_MODEL_PRICES to make the number real.
 */
export function estimateCostUsd(
  prices: Record<string, ModelPrice>,
  provider: string,
  model: string,
  usage: TokenUsage
): number {
  const price = priceFor(prices, provider, model);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const freshInput = Math.max(0, usage.inputTokens - cached);
  const total =
    (freshInput * price.inputPerMillion +
      cached * price.cachedInputPerMillion +
      Math.max(0, usage.outputTokens) * price.outputPerMillion) /
    1_000_000;
  return Math.round(total * 1e8) / 1e8;
}

export interface RecordUsageInput {
  generationRequestId: string;
  userId: string;
  conversationId?: string | null;
  usageMode: 'PLATFORM' | 'BYOK';
  quotaSource: QuotaSource;
  purpose: UsagePurpose;
  provider: string;
  model: string;
  usage: TokenUsage;
  quotaUnits: number;
  cycleId?: string | null;
  batchId?: string | null;
  status?: 'RESERVED' | 'FINALIZED' | 'REVERSED';
}

/**
 * Upserts the cost row for one (request, purpose). Safe to call twice — a replayed
 * finalization overwrites the same row instead of double-counting spend.
 */
export async function recordUsage(
  database: PomChatDatabase,
  config: CloudConfig,
  input: RecordUsageInput
): Promise<number> {
  const cost = estimateCostUsd(
    config.modelPrices,
    input.provider,
    input.model,
    input.usage
  );
  const status = input.status ?? 'FINALIZED';
  await database.query(
    `INSERT INTO model_usage_ledger (
       usage_id, generation_request_id, user_id, usage_mode, provider, model_name,
       status, input_tokens, output_tokens, cached_input_tokens,
       quota_source, quota_units, cycle_id, batch_id, conversation_id, purpose,
       actual_cost_usd, estimated_cost, finalized_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $17, $18
     )
     ON CONFLICT (generation_request_id, purpose) DO UPDATE SET
       status = EXCLUDED.status,
       provider = EXCLUDED.provider,
       model_name = EXCLUDED.model_name,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       cached_input_tokens = EXCLUDED.cached_input_tokens,
       quota_source = EXCLUDED.quota_source,
       quota_units = EXCLUDED.quota_units,
       cycle_id = EXCLUDED.cycle_id,
       batch_id = EXCLUDED.batch_id,
       conversation_id = EXCLUDED.conversation_id,
       actual_cost_usd = EXCLUDED.actual_cost_usd,
       estimated_cost = EXCLUDED.estimated_cost,
       finalized_at = EXCLUDED.finalized_at`,
    [
      randomUUID(),
      input.generationRequestId,
      input.userId,
      input.usageMode,
      input.provider,
      input.model,
      status,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.cachedInputTokens ?? null,
      input.quotaSource,
      input.quotaUnits,
      input.cycleId ?? null,
      input.batchId ?? null,
      input.conversationId ?? null,
      input.purpose,
      cost,
      status === 'FINALIZED' ? new Date().toISOString() : null
    ]
  );
  return cost;
}

/** Platform spend (Trial + Alpha) since `since`, in USD. */
export async function platformSpendUsd(
  database: PomChatDatabase,
  since: Date
): Promise<number> {
  const result = await database.query<{ total: string | number | null }>(
    `SELECT COALESCE(SUM(actual_cost_usd), 0) AS total
     FROM model_usage_ledger
     WHERE quota_source IN ('TRIAL', 'ALPHA')
       AND status <> 'REVERSED'
       AND created_at >= $1`,
    [since.toISOString()]
  );
  return Number(result.rows[0]?.total ?? 0);
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Global budget circuit breaker. When the configured monthly ceiling is reached the
 * hosted model path stops accepting new platform-paid calls; BYOK is unaffected, so
 * the product keeps working for anyone with their own key.
 */
export async function assertGlobalBudget(
  database: PomChatDatabase,
  config: CloudConfig,
  now: Date = new Date()
): Promise<void> {
  if (config.globalMonthlyBudgetUsd <= 0) return;
  const spent = await platformSpendUsd(database, monthStart(now));
  if (spent >= config.globalMonthlyBudgetUsd) {
    throw new AppError(
      'CLOUD_BUDGET_EXHAUSTED',
      'LiteTavern Cloud 本月的平台模型预算已用完。你可以切换到自己的模型服务继续聊天。',
      503,
      true
    );
  }
}

export interface BatchCostSummary {
  batchId: string;
  users: number;
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  quotaUnits: number;
  costUsd: number;
}

/** Per-batch cost/activity, the number an operator needs before opening the next batch. */
export async function batchCostSummary(
  database: PomChatDatabase,
  batchId: string
): Promise<BatchCostSummary> {
  const usage = await database.query<{
    users: number;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    quota_units: number;
    cost: string | number | null;
  }>(
    `SELECT COUNT(DISTINCT user_id)::int AS users,
            COUNT(*)::int AS requests,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
            COALESCE(SUM(quota_units), 0)::int AS quota_units,
            COALESCE(SUM(actual_cost_usd), 0) AS cost
     FROM model_usage_ledger
     WHERE batch_id = $1 AND status <> 'REVERSED'`,
    [batchId]
  );
  const failures = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM model_usage_ledger
     WHERE batch_id = $1 AND status = 'REVERSED'`,
    [batchId]
  );
  const row = usage.rows[0];
  return {
    batchId,
    users: Number(row?.users ?? 0),
    requests: Number(row?.requests ?? 0),
    failedRequests: Number(failures.rows[0]?.count ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    quotaUnits: Number(row?.quota_units ?? 0),
    costUsd: Number(row?.cost ?? 0)
  };
}
