import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  alphaBatchCreateSchema,
  alphaBatchUnlockSchema,
  alphaBatchUpdateSchema,
  alphaBlockerCreateSchema,
  alphaBlockerTransitionSchema,
  alphaFeedbackTriageSchema,
  alphaReadinessConfirmSchema,
  alphaReleaseSchema,
  alphaSeatReclaimSchema,
  foundingSupporterSchema,
  membershipTransitionSchema
} from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { ADMIN_CONSOLE_HTML } from './admin-console.js';
import type { CloudConfig } from './config.js';
import { platformSpendUsd } from './cost.js';
import { recordCloudEvent } from './events.js';
import {
  createBatch,
  getBatchMetrics,
  listBatches,
  releaseUsers,
  updateBatch
} from './batches.js';
import {
  listFeedback,
  listBlockers,
  recordBlocker,
  transitionBlocker,
  triageFeedback
} from './feedback.js';
import { listWaitlist, transitionAlpha } from './membership.js';
import {
  getPlan,
  getSeatUsage,
  listCapacityAudit,
  reclaimSeat,
  unlockBatchTwo
} from './plan.js';
import {
  confirmReadiness,
  effectiveTesters,
  evaluateReadiness
} from './readiness.js';
import { markFoundingSupporter } from './supporter.js';

const ADMIN_HEADER = 'x-litetavern-admin-token';

/**
 * Minimal LiteTavern Cloud operator API.
 *
 * Authenticated by a single shared token supplied through CLOUD_ADMIN_TOKEN. When
 * that variable is unset every route below returns 404, so a default deployment ships
 * with no administrative surface at all rather than a guessable default credential.
 */
export function registerCloudAdminRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  config: CloudConfig
) {
  function requireAdmin(request: FastifyRequest): string {
    if (!config.adminToken) {
      throw new AppError('RESOURCE_NOT_FOUND', '接口不存在。', 404);
    }
    const provided = request.headers[ADMIN_HEADER];
    const supplied = typeof provided === 'string' ? provided : '';
    const expected = Buffer.from(config.adminToken);
    const actual = Buffer.from(supplied);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new AppError('UNAUTHORIZED', '管理员令牌无效。', 401);
    }
    return 'admin';
  }

  /**
   * Operator console shell. Served from the closed service rather than the open web
   * client so the admin surface never ships in a fork of `apps/web`.
   *
   * The document itself carries no data — a browser cannot send the admin header on a
   * navigation — so it is gated on CLOUD_ADMIN_TOKEN being configured (404 otherwise,
   * like the rest of this surface) but does not verify the header. Everything the page
   * displays or changes goes through the token-authenticated routes below.
   */
  app.get('/v1/cloud/admin/alpha/console', async (request, reply) => {
    if (!config.adminToken) {
      throw new AppError('RESOURCE_NOT_FOUND', '接口不存在。', 404);
    }
    void request;
    return reply
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex, nofollow')
      .type('text/html; charset=utf-8')
      .send(ADMIN_CONSOLE_HTML);
  });

  app.post('/v1/cloud/admin/batches', async (request, reply) => {
    const operator = requireAdmin(request);
    const body = alphaBatchCreateSchema.parse(request.body);
    const batch = await createBatch(database, config, {
      name: body.name,
      capacity: body.capacity,
      ...(body.quota_policy ? { quotaPolicy: body.quota_policy } : {}),
      ...(body.budget_limit_usd === undefined
        ? {}
        : { budgetLimitUsd: body.budget_limit_usd }),
      ...(body.notes ? { notes: body.notes } : {}),
      createdBy: operator
    });
    reply.code(201);
    return { batch };
  });

  app.get('/v1/cloud/admin/batches', async (request) => {
    requireAdmin(request);
    return { batches: await listBatches(database, config) };
  });

  app.patch<{ Params: { batchId: string } }>(
    '/v1/cloud/admin/batches/:batchId',
    async (request) => {
      requireAdmin(request);
      const body = alphaBatchUpdateSchema.parse(request.body);
      const batch = await updateBatch(database, config, request.params.batchId, {
        ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.quota_policy ? { quotaPolicy: body.quota_policy } : {}),
        ...(body.budget_limit_usd === undefined
          ? {}
          : { budgetLimitUsd: body.budget_limit_usd }),
        ...(body.notes === undefined ? {} : { notes: body.notes })
      });
      return { batch };
    }
  );

  app.get('/v1/cloud/admin/waitlist', async (request) => {
    requireAdmin(request);
    const limit = Number((request.query as { limit?: string })?.limit ?? 100);
    return {
      waitlist: await listWaitlist(
        database,
        Number.isInteger(limit) ? limit : 100
      )
    };
  });

  // Release users into a batch: explicit ids (targeted invite / admin grant) or the
  // next N from the priority-ordered waitlist.
  app.post<{ Params: { batchId: string } }>(
    '/v1/cloud/admin/batches/:batchId/release',
    async (request) => {
      const operator = requireAdmin(request);
      const body = alphaReleaseSchema.parse(request.body);
      const result = await releaseUsers(database, config, {
        batchId: request.params.batchId,
        ...(body.user_ids ? { userIds: body.user_ids } : {}),
        ...(body.count === undefined ? {} : { count: body.count }),
        ...(body.grant_source ? { grantSource: body.grant_source } : {}),
        grantedBy: operator
      });
      return { release: result };
    }
  );

  app.get<{ Params: { batchId: string } }>(
    '/v1/cloud/admin/batches/:batchId/metrics',
    async (request) => {
      requireAdmin(request);
      return {
        metrics: await getBatchMetrics(database, config, request.params.batchId)
      };
    }
  );

  // Pause / resume / end one user's Alpha. Ending frees the batch seat and revokes
  // the grant; it does not delete anything the user created.
  app.post<{ Params: { userId: string } }>(
    '/v1/cloud/admin/members/:userId/transition',
    async (request) => {
      const operator = requireAdmin(request);
      const body = membershipTransitionSchema.parse(request.body);
      const membership = await transitionAlpha(
        database,
        request.params.userId,
        body.transition,
        body.reason,
        operator
      );
      const eventName =
        body.transition === 'PAUSE'
          ? 'alpha_paused'
          : body.transition === 'END'
            ? 'alpha_ended'
            : 'alpha_activated';
      await recordCloudEvent(database, eventName, {
        userId: request.params.userId,
        properties: {
          batch_id: membership.batchId ?? '',
          grant_source: membership.grantSource ?? ''
        }
      });
      return { membership };
    }
  );

  app.post('/v1/cloud/admin/supporters', async (request, reply) => {
    const operator = requireAdmin(request);
    const body = foundingSupporterSchema.parse(request.body);
    const result = await markFoundingSupporter(database, {
      userId: body.user_id,
      ...(body.display_name ? { displayName: body.display_name } : {}),
      ...(body.anonymous === undefined ? {} : { anonymous: body.anonymous }),
      ...(body.external_reference
        ? { externalReference: body.external_reference }
        : {}),
      ...(body.note ? { note: body.note } : {}),
      markedBy: operator
    });
    reply.code(result.marked ? 201 : 200);
    return result;
  });

  // ===== Alpha capacity plan (v0.1.0 two-wave release) =====

  // Everything the operator needs on one screen: seats, waves, queue, testers,
  // stability, outstanding work and cost.
  app.get('/v1/cloud/admin/alpha/overview', async (request) => {
    requireAdmin(request);
    const plan = await getPlan(database);
    const seats = await getSeatUsage(database);
    const readiness = await evaluateReadiness(database, config);
    const testers = await effectiveTesters(database, 1);

    return {
      overview: {
        plan,
        seats,
        batch_1: {
          batch_no: 1,
          capacity: plan.batch_1_capacity,
          status: 'RELEASED'
        },
        batch_2: {
          batch_no: 2,
          capacity: plan.batch_2_capacity,
          status: plan.batch_2_unlocked ? 'RELEASED' : 'LOCKED',
          unlocked_at: plan.batch_2_unlocked_at,
          unlocked_by: plan.batch_2_unlocked_by
        },
        effective_testers: readiness.metrics.effective_testers,
        tester_breakdown: testers,
        stable_core_sessions: readiness.checks.find(
          (check) => check.key === 'stable_core_sessions'
        )?.actual ?? 0,
        unresolved_blockers: readiness.metrics.unresolved_blockers,
        outstanding_feedback: readiness.metrics.outstanding_feedback,
        cost: {
          batch_1_cost_usd: readiness.metrics.batch_1_cost_usd,
          average_cost_per_effective_tester_usd:
            readiness.metrics.average_cost_per_effective_tester_usd,
          recent_model_failure_rate: readiness.metrics.recent_model_failure_rate,
          recent_model_requests: readiness.metrics.recent_model_requests,
          provider_incidents: readiness.metrics.provider_incidents
        }
      }
    };
  });

  // The wave-2 checklist. Every item carries its current value, requirement,
  // pass/fail, the evidence it was derived from and why it failed.
  app.get('/v1/cloud/admin/alpha/readiness', async (request) => {
    requireAdmin(request);
    return { readiness: await evaluateReadiness(database, config) };
  });

  // The one condition the system cannot judge for itself. Records the operator, the
  // time and the metrics they were shown.
  app.post('/v1/cloud/admin/alpha/readiness/confirm', async (request, reply) => {
    const operator = requireAdmin(request);
    const body = alphaReadinessConfirmSchema.parse(request.body ?? {});
    const confirmation = await confirmReadiness(database, config, {
      actor: operator,
      batchNo: 1,
      ...(body.note ? { note: body.note } : {})
    });
    await recordCloudEvent(database, 'alpha_readiness_confirmed', {
      properties: { batch_no: 1, confirmed_by: operator }
    });
    reply.code(201);
    return { confirmation };
  });

  /**
   * Unlocks wave 2.
   *
   * The request body carries no condition results. Every automatic gate is
   * re-evaluated here, server-side, immediately before the state change, so a stale
   * or forged client view cannot get past one. A repeat request is idempotent and
   * returns the original unlock rather than re-running it.
   */
  app.post('/v1/cloud/admin/alpha/batch-2/unlock', async (request, reply) => {
    const operator = requireAdmin(request);
    const body = alphaBatchUnlockSchema.parse(request.body ?? {});

    const readiness = await evaluateReadiness(database, config);
    if (readiness.already_unlocked) {
      reply.code(200);
      return {
        unlocked: false,
        already_unlocked: true,
        plan: await getPlan(database),
        readiness
      };
    }
    if (!readiness.can_unlock) {
      // The full checklist goes back in the body so the operator sees every
      // unmet item at once rather than one reason at a time.
      reply.code(409).send({
        error: {
          code: 'ALPHA_UNLOCK_CONDITIONS_UNMET',
          message: `第二批放量条件尚未全部满足：${readiness.blocking_reasons.join(' ')}`,
          retryable: false,
          request_id: request.id
        },
        readiness
      });
      return reply;
    }

    const result = await unlockBatchTwo(database, {
      actor: operator,
      evidence: {
        checks: readiness.checks,
        metrics: readiness.metrics,
        confirmation: readiness.confirmation,
        ...(body.note ? { note: body.note } : {})
      }
    });
    if (result.unlocked) {
      await recordCloudEvent(database, 'alpha_batch_2_unlocked', {
        properties: {
          released_capacity: result.plan.released_capacity,
          total_capacity: result.plan.total_capacity,
          effective_testers: readiness.metrics.effective_testers,
          unresolved_blockers: readiness.metrics.unresolved_blockers
        }
      });
    }
    reply.code(result.unlocked ? 201 : 200);
    return { ...result, readiness };
  });

  // Free a seat held by someone who never started or has stopped. The freed seat
  // stays part of the wave it came from — reclaiming never opens wave 2.
  app.post<{ Params: { userId: string } }>(
    '/v1/cloud/admin/alpha/members/:userId/reclaim',
    async (request) => {
      const operator = requireAdmin(request);
      const body = alphaSeatReclaimSchema.parse(request.body);
      const result = await reclaimSeat(database, {
        userId: request.params.userId,
        actor: operator,
        reason: body.reason
      });
      if (result.reclaimed) {
        await recordCloudEvent(database, 'alpha_seat_reclaimed', {
          userId: request.params.userId,
          properties: { reason: body.reason }
        });
      }
      return { ...result, seats: await getSeatUsage(database) };
    }
  );

  app.get('/v1/cloud/admin/alpha/audit', async (request) => {
    requireAdmin(request);
    const query = request.query as { user_id?: string; limit?: string };
    const limit = Number(query?.limit ?? 100);
    return {
      audit: await listCapacityAudit(database, {
        ...(query?.user_id ? { userId: query.user_id } : {}),
        limit: Number.isInteger(limit) ? limit : 100
      })
    };
  });

  // ===== Feedback & blocker registers =====

  app.get('/v1/cloud/admin/alpha/feedback', async (request) => {
    requireAdmin(request);
    const query = request.query as { outstanding?: string; batch_no?: string };
    const batchNo = Number(query?.batch_no);
    return {
      feedback: await listFeedback(database, {
        outstandingOnly: query?.outstanding === 'true',
        ...(Number.isInteger(batchNo) ? { batchNo } : {})
      })
    };
  });

  app.patch<{ Params: { feedbackId: string } }>(
    '/v1/cloud/admin/alpha/feedback/:feedbackId',
    async (request) => {
      const operator = requireAdmin(request);
      const body = alphaFeedbackTriageSchema.parse(request.body);
      return {
        feedback: await triageFeedback(database, {
          feedbackId: request.params.feedbackId,
          actor: operator,
          ...(body.category ? { category: body.category } : {}),
          ...(body.severity ? { severity: body.severity } : {}),
          ...(body.disposition ? { disposition: body.disposition } : {}),
          ...(body.disposition_note
            ? { dispositionNote: body.disposition_note }
            : {}),
          ...(body.duplicate_of_feedback_id
            ? { duplicateOfFeedbackId: body.duplicate_of_feedback_id }
            : {}),
          ...(body.valid === undefined ? {} : { valid: body.valid })
        })
      };
    }
  );

  app.get('/v1/cloud/admin/alpha/blockers', async (request) => {
    requireAdmin(request);
    const query = request.query as { unresolved?: string };
    return {
      blockers: await listBlockers(database, {
        unresolvedOnly: query?.unresolved === 'true'
      })
    };
  });

  app.post('/v1/cloud/admin/alpha/blockers', async (request, reply) => {
    const operator = requireAdmin(request);
    const body = alphaBlockerCreateSchema.parse(request.body);
    const blocker = await recordBlocker(database, {
      blockerType: body.blocker_type,
      title: body.title,
      detectedBy: operator,
      ...(body.detail ? { detail: body.detail } : {}),
      ...(body.batch_no === undefined ? {} : { batchNo: body.batch_no }),
      ...(body.user_id ? { userId: body.user_id } : {}),
      ...(body.feedback_id ? { feedbackId: body.feedback_id } : {}),
      ...(body.recurrence_of ? { recurrenceOf: body.recurrence_of } : {})
    });
    reply.code(201);
    return { blocker };
  });

  app.post<{ Params: { blockerId: string } }>(
    '/v1/cloud/admin/alpha/blockers/:blockerId/transition',
    async (request) => {
      const operator = requireAdmin(request);
      const body = alphaBlockerTransitionSchema.parse(request.body);
      return {
        blocker: await transitionBlocker(database, {
          blockerId: request.params.blockerId,
          transition: body.transition,
          actor: operator
        })
      };
    }
  );

  // Program-level spend, for checking a batch against the global budget.
  app.get('/v1/cloud/admin/budget', async (request) => {
    requireAdmin(request);
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const spent = await platformSpendUsd(database, since);
    return {
      budget: {
        month_start: since.toISOString(),
        spent_usd: spent,
        limit_usd: config.globalMonthlyBudgetUsd,
        circuit_breaker_enabled: config.globalMonthlyBudgetUsd > 0,
        exhausted:
          config.globalMonthlyBudgetUsd > 0 &&
          spent >= config.globalMonthlyBudgetUsd
      }
    };
  });
}
