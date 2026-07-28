import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import type { CloudConfig } from './config.js';
import { assertGlobalBudget, recordUsage, type TokenUsage, type UsagePurpose } from './cost.js';
import { recordCloudEvent } from './events.js';
import { ensureMembership, readBatchPolicy } from './membership.js';
import {
  finalizeQuota,
  releaseQuota,
  reserveQuota,
  resolveQuota,
  type QuotaSnapshot,
  type QuotaSource
} from './quota.js';

/**
 * The quota gate around one platform-paid model call.
 *
 * Generation routes only need three steps — open the gate before calling the model,
 * settle it on success, abort it on failure — and this module owns everything behind
 * them: which pool pays (Trial or Alpha), how many units the call costs, the global
 * budget breaker, the cost ledger and the program analytics.
 *
 * BYOK never passes through here. A user's own key spends neither Trial nor Alpha and
 * is deliberately outside this boundary.
 */

export interface PlatformGate {
  source: QuotaSource;
  units: number;
  cycleId: string | null;
  batchId: string | null;
  snapshot: QuotaSnapshot;
}

/** Current platform allowance without reserving anything (replays, status echoes). */
export async function readPlatformQuota(
  database: PomChatDatabase,
  config: CloudConfig,
  userId: string,
  registered: boolean
): Promise<QuotaSnapshot> {
  const membership = await ensureMembership(database, userId, registered);
  const policy = membership.batchId
    ? await readBatchPolicy(database, membership.batchId, config.defaultAlphaPolicy)
    : config.defaultAlphaPolicy;
  return resolveQuota(database, {
    userId,
    membershipStatus: membership.status,
    policy,
    trialEnabled: config.trialEnabled
  });
}

export interface OpenGateInput {
  userId: string;
  registered: boolean;
  requestId: string;
  provider: string;
  model: string;
}

/**
 * Reserves quota for a platform request. Throws when the user has no platform
 * allowance left (or the global budget is spent), in which case the caller must not
 * make the model call — BYOK remains available to them.
 */
export async function openPlatformGate(
  database: PomChatDatabase,
  config: CloudConfig,
  input: OpenGateInput
): Promise<PlatformGate> {
  await assertGlobalBudget(database, config);

  const membership = await ensureMembership(
    database,
    input.userId,
    input.registered
  );
  const policy = membership.batchId
    ? await readBatchPolicy(database, membership.batchId, config.defaultAlphaPolicy)
    : config.defaultAlphaPolicy;

  try {
    const reservation = await reserveQuota(database, {
      userId: input.userId,
      membershipStatus: membership.status,
      policy,
      trialEnabled: config.trialEnabled,
      requestId: input.requestId,
      provider: input.provider,
      model: input.model
    });

    if (!reservation.acquired) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        '相同请求正在处理中，请稍后重试。',
        409,
        true
      );
    }

    return {
      source: reservation.source,
      units: reservation.units,
      cycleId: reservation.cycleId,
      batchId: membership.batchId,
      snapshot: reservation.snapshot
    };
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'FREE_QUOTA_EXHAUSTED' ||
        error.code === 'CLOUD_QUOTA_EXHAUSTED')
    ) {
      await recordCloudEvent(
        database,
        error.code === 'FREE_QUOTA_EXHAUSTED'
          ? 'cloud_trial_exhausted'
          : 'alpha_quota_exhausted',
        {
          userId: input.userId,
          properties: {
            membership_status: membership.status,
            batch_id: membership.batchId ?? ''
          }
        }
      );
    }
    throw error;
  }
}

export interface SettleGateInput extends OpenGateInput {
  gate: PlatformGate;
  generationRequestId: string;
  conversationId?: string | null;
  usage: TokenUsage;
  purpose?: UsagePurpose;
}

/** Deducts the reservation and writes the real cost row. Idempotent. */
export async function settlePlatformGate(
  database: PomChatDatabase,
  config: CloudConfig,
  input: SettleGateInput
): Promise<QuotaSnapshot> {
  const membership = await ensureMembership(
    database,
    input.userId,
    input.registered
  );
  const policy = membership.batchId
    ? await readBatchPolicy(database, membership.batchId, config.defaultAlphaPolicy)
    : config.defaultAlphaPolicy;

  const snapshot = await finalizeQuota(database, {
    userId: input.userId,
    membershipStatus: membership.status,
    policy,
    trialEnabled: config.trialEnabled,
    requestId: input.requestId,
    provider: input.provider,
    model: input.model,
    source: input.gate.source,
    units: input.gate.units,
    cycleId: input.gate.cycleId
  });

  await recordUsage(database, config, {
    generationRequestId: input.generationRequestId,
    userId: input.userId,
    conversationId: input.conversationId ?? null,
    usageMode: 'PLATFORM',
    quotaSource: input.gate.source,
    purpose: input.purpose ?? 'MAIN_REPLY',
    provider: input.provider,
    model: input.model,
    usage: input.usage,
    quotaUnits: input.gate.units,
    cycleId: input.gate.cycleId,
    batchId: input.gate.batchId,
    status: 'FINALIZED'
  });

  await recordCloudEvent(
    database,
    input.gate.source === 'ALPHA' ? 'alpha_quota_used' : 'cloud_trial_used',
    {
      userId: input.userId,
      properties: {
        units: input.gate.units,
        remaining: snapshot.available,
        remaining_ratio: snapshot.remainingRatio,
        batch_id: input.gate.batchId ?? '',
        provider: input.provider,
        model: input.model
      }
    }
  );

  if (snapshot.available === 0) {
    await recordCloudEvent(
      database,
      input.gate.source === 'ALPHA'
        ? 'alpha_quota_exhausted'
        : 'cloud_trial_exhausted',
      {
        userId: input.userId,
        properties: { batch_id: input.gate.batchId ?? '' }
      }
    );
  }

  return snapshot;
}

export interface AbortGateInput extends OpenGateInput {
  gate: PlatformGate;
  failureCode: string;
}

/** Returns the reservation after a failed call — a failure must never cost quota. */
export async function abortPlatformGate(
  database: PomChatDatabase,
  config: CloudConfig,
  input: AbortGateInput
): Promise<void> {
  const membership = await ensureMembership(
    database,
    input.userId,
    input.registered
  );
  const policy = membership.batchId
    ? await readBatchPolicy(database, membership.batchId, config.defaultAlphaPolicy)
    : config.defaultAlphaPolicy;

  await releaseQuota(database, {
    userId: input.userId,
    membershipStatus: membership.status,
    policy,
    trialEnabled: config.trialEnabled,
    requestId: input.requestId,
    provider: input.provider,
    model: input.model,
    source: input.gate.source,
    units: input.gate.units,
    cycleId: input.gate.cycleId,
    failureCode: input.failureCode
  });
}
