import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  alphaBatchCreateSchema,
  alphaBatchUpdateSchema,
  alphaReleaseSchema,
  foundingSupporterSchema,
  membershipTransitionSchema
} from '@pomchat/contracts';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
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
import { listWaitlist, transitionAlpha } from './membership.js';
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
      requireAdmin(request);
      const body = membershipTransitionSchema.parse(request.body);
      const membership = await transitionAlpha(
        database,
        request.params.userId,
        body.transition,
        body.reason
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
