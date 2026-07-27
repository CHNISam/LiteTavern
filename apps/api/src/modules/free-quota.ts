import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../lib/errors.js';

export interface FreeQuotaSnapshot {
  total: number;
  remaining: number;
  reserved: number;
  available: number;
  grantedAt: string;
}

interface QuotaRow {
  free_quota_total: number;
  free_quota_remaining: number;
  free_quota_reserved: number;
  free_quota_granted_at: string;
}

function snapshot(row: QuotaRow): FreeQuotaSnapshot {
  return {
    total: Number(row.free_quota_total),
    remaining: Number(row.free_quota_remaining),
    reserved: Number(row.free_quota_reserved),
    available: Math.max(
      Number(row.free_quota_remaining) - Number(row.free_quota_reserved),
      0
    ),
    grantedAt: String(row.free_quota_granted_at)
  };
}

async function readQuota(
  database: PomChatDatabase,
  userId: string
): Promise<FreeQuotaSnapshot> {
  const result = await database.query<QuotaRow>(
    `SELECT free_quota_total, free_quota_remaining,
            free_quota_reserved, free_quota_granted_at
     FROM app_user
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError('UNAUTHORIZED', '用户身份无效。', 401);
  return snapshot(row);
}

export async function getFreeQuota(
  database: PomChatDatabase,
  userId: string
): Promise<FreeQuotaSnapshot> {
  return readQuota(database, userId);
}

export async function initializeFreeQuota(
  database: PomChatDatabase,
  userId: string,
  initialCount: number
): Promise<FreeQuotaSnapshot> {
  if (!Number.isInteger(initialCount) || initialCount < 0) {
    throw new Error('FREE_QUOTA_INITIAL_COUNT must be a non-negative integer.');
  }
  await database.transaction(async (transaction) => {
    const inserted = await transaction.query<{ quota_ledger_id: string }>(
      `INSERT INTO free_quota_ledger (
         quota_ledger_id, user_id, action_type, delta,
         balance_before, balance_after, status
       ) VALUES ($1, $2, 'GRANT', $3, 0, $3, 'GRANTED')
       ON CONFLICT DO NOTHING
       RETURNING quota_ledger_id`,
      [randomUUID(), userId, initialCount]
    );
    if (!inserted.rows[0]) return;
    await transaction.query(
      `UPDATE app_user
       SET free_quota_total = $2,
           free_quota_remaining = $2,
           free_quota_reserved = 0,
           free_quota_granted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [userId, initialCount]
    );
  });
  return readQuota(database, userId);
}

export async function reserveFreeQuota(
  database: PomChatDatabase,
  userId: string,
  requestId: string
): Promise<{
  acquired: boolean;
  replayed: boolean;
  quota: FreeQuotaSnapshot;
}> {
  let didReserve = false;
  let replayed = false;
  await database.transaction(async (transaction) => {
    const existing = await transaction.query<{ status: string }>(
      `SELECT status
       FROM free_quota_ledger
       WHERE user_id = $1 AND request_id = $2 AND action_type = 'RESERVE'`,
      [userId, requestId]
    );
    if (existing.rows[0]) {
      replayed = true;
      return;
    }

    const updated = await transaction.query<{
      before_balance: number;
      after_available: number;
    }>(
      `UPDATE app_user
       SET free_quota_reserved = free_quota_reserved + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
         AND status = 'ACTIVE'
         AND free_quota_remaining - free_quota_reserved > 0
       RETURNING free_quota_remaining AS before_balance,
                 free_quota_remaining - free_quota_reserved AS after_available`,
      [userId]
    );
    const row = updated.rows[0];
    if (!row) {
      throw new AppError(
        'FREE_QUOTA_EXHAUSTED',
        '你的官方免费回复次数已用完。你可以配置自己的模型服务继续聊天。',
        429
      );
    }
    await transaction.query(
      `INSERT INTO free_quota_ledger (
         quota_ledger_id, user_id, request_id, action_type, delta,
         balance_before, balance_after, status
       ) VALUES ($1, $2, $3, 'RESERVE', 0, $4, $4, 'RESERVED')`,
      [randomUUID(), userId, requestId, Number(row.before_balance)]
    );
    didReserve = true;
  });
  const current = await readQuota(database, userId);
  return { acquired: didReserve, replayed, quota: current };
}

export interface FinalizeFreeQuotaInput {
  userId: string;
  requestId: string;
  provider: string;
  model: string;
}

export async function finalizeFreeQuota(
  database: PomChatDatabase,
  input: FinalizeFreeQuotaInput
): Promise<FreeQuotaSnapshot> {
  await database.transaction(async (transaction) => {
    const prior = await transaction.query<{ quota_ledger_id: string }>(
      `SELECT quota_ledger_id
       FROM free_quota_ledger
       WHERE user_id = $1 AND request_id = $2 AND action_type = 'CONSUME'`,
      [input.userId, input.requestId]
    );
    if (prior.rows[0]) return;

    const reservation = await transaction.query<{ quota_ledger_id: string }>(
      `UPDATE free_quota_ledger
       SET status = 'FINALIZED', provider = $3, model = $4
       WHERE user_id = $1 AND request_id = $2
         AND action_type = 'RESERVE' AND status = 'RESERVED'
       RETURNING quota_ledger_id`,
      [input.userId, input.requestId, input.provider, input.model]
    );
    if (!reservation.rows[0]) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        '免费额度请求状态不一致，请勿重复提交。',
        409
      );
    }

    const updated = await transaction.query<{
      balance_before: number;
      balance_after: number;
    }>(
      `UPDATE app_user
       SET free_quota_remaining = free_quota_remaining - 1,
           free_quota_reserved = free_quota_reserved - 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
         AND free_quota_remaining > 0
         AND free_quota_reserved > 0
       RETURNING free_quota_remaining + 1 AS balance_before,
                 free_quota_remaining AS balance_after`,
      [input.userId]
    );
    const balance = updated.rows[0];
    if (!balance) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        '免费额度结算失败，请稍后重试。',
        409
      );
    }
    await transaction.query(
      `INSERT INTO free_quota_ledger (
         quota_ledger_id, user_id, request_id, action_type, delta,
         balance_before, balance_after, provider, model, status
       ) VALUES ($1, $2, $3, 'CONSUME', -1, $4, $5, $6, $7, 'FINALIZED')`,
      [
        randomUUID(),
        input.userId,
        input.requestId,
        Number(balance.balance_before),
        Number(balance.balance_after),
        input.provider,
        input.model
      ]
    );
  });
  return readQuota(database, input.userId);
}

export interface ReleaseFreeQuotaInput extends FinalizeFreeQuotaInput {
  failureCode: string;
}

export async function releaseFreeQuota(
  database: PomChatDatabase,
  input: ReleaseFreeQuotaInput
): Promise<FreeQuotaSnapshot> {
  await database.transaction(async (transaction) => {
    const released = await transaction.query<{ quota_ledger_id: string }>(
      `UPDATE free_quota_ledger
       SET status = 'RELEASED', provider = $3, model = $4,
           failure_code = $5
       WHERE user_id = $1 AND request_id = $2
         AND action_type = 'RESERVE' AND status = 'RESERVED'
       RETURNING quota_ledger_id`,
      [
        input.userId,
        input.requestId,
        input.provider,
        input.model,
        input.failureCode
      ]
    );
    if (!released.rows[0]) return;
    const updated = await transaction.query<{ balance: number }>(
      `UPDATE app_user
       SET free_quota_reserved = free_quota_reserved - 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND free_quota_reserved > 0
       RETURNING free_quota_remaining AS balance`,
      [input.userId]
    );
    const balance = Number(updated.rows[0]?.balance ?? 0);
    await transaction.query(
      `INSERT INTO free_quota_ledger (
         quota_ledger_id, user_id, request_id, action_type, delta,
         balance_before, balance_after, provider, model, status, failure_code
       ) VALUES ($1, $2, $3, 'FAILURE', 0, $4, $4, $5, $6, 'FAILED', $7)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        input.userId,
        input.requestId,
        balance,
        input.provider,
        input.model,
        input.failureCode
      ]
    );
  });
  return readQuota(database, input.userId);
}
