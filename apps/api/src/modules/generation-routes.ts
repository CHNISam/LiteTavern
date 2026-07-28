import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { LiteTavernDatabase } from '@litetavern/database';
import {
  generationRequestSchema,
  turnBubbleSchema,
  type GenerationRequestInput
} from '@litetavern/contracts';
import { AppError } from '../lib/errors.js';
import { resolveUserId } from './identity.js';
import { assembleContext } from './context-assembler.js';
import type { ModelGateway } from './providers/model-gateway.js';
import {
  resolveCredential,
  type PlatformProviderConfig
} from './providers/credentials.js';
import {
  createOfficialProviderRouter,
  type OfficialCompletionMetadata
} from './providers/official-providers.js';
import {
  finalizeFreeQuota,
  getFreeQuota,
  releaseFreeQuota,
  reserveFreeQuota
} from './free-quota.js';
import { FreeTrafficGuard } from './free-traffic-guard.js';

interface GenerationRouteOptions {
  database: LiteTavernDatabase;
  gateway: ModelGateway;
  platform: PlatformProviderConfig;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSuggestions(raw: string): string[] {
  const tidy = (list: string[]) =>
    list
      .map((item) => item.replace(/^[\s"'“”「」\-\d.、)）]+/, '').replace(/[\s"'“”「」]+$/, '').trim())
      .filter((item) => item.length > 0 && item.length <= 40);
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (Array.isArray(parsed)) {
        const strings = tidy(parsed.filter((item): item is string => typeof item === 'string'));
        if (strings.length) return [...new Set(strings)].slice(0, 3);
      }
    } catch {
      /* fall back to line parsing */
    }
  }
  return [...new Set(tidy(raw.split(/\r?\n/)))].slice(0, 3);
}

const MAX_MESSAGES_PER_TURN = 4;

// Deterministic instruction that turns one model call into a short 1–4 bubble reply.
// The model owns the semantic split only; timing/pacing is the client's job.
const MULTI_BUBBLE_INSTRUCTION =
  '\n\n[发言形式] 你在用手机短信和对方聊天。请把这一轮回复拆成 1~4 条独立的短信气泡，' +
  '默认优先 1~2 条，只有语义或情绪确实需要时才更多，不要为了凑数而机械拆句。' +
  '只输出一个 JSON：{"messages":["第一条","第二条"]}，每条不含编号或引号，不要输出 JSON 以外的任何内容。';

// Accept the documented {messages:[...]} shape, a bare JSON array, or — as a last
// resort — degrade any other output to a single bubble carrying the raw text.
function parseModelTurn(raw: string): string[] {
  const take = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      const fromArray = take(parsed);
      if (fromArray) return fromArray;
      if (parsed && typeof parsed === 'object') {
        const fromMessages = take((parsed as { messages?: unknown }).messages);
        if (fromMessages) return fromMessages;
      }
    } catch {
      /* fall through to single-bubble degrade */
    }
  }
  return [raw];
}

// Trim, drop empties, and fold any overflow past the cap into the last bubble.
function normalizeTurn(messages: string[]): string[] {
  const cleaned = messages.map((text) => text.trim()).filter((text) => text.length > 0);
  if (cleaned.length <= MAX_MESSAGES_PER_TURN) return cleaned;
  const head = cleaned.slice(0, MAX_MESSAGES_PER_TURN - 1);
  const merged = cleaned.slice(MAX_MESSAGES_PER_TURN - 1).join('\n');
  return [...head, merged];
}

export function registerGenerationRoutes(
  app: FastifyInstance,
  { database, gateway, platform }: GenerationRouteOptions
) {
  const officialRouter = createOfficialProviderRouter(gateway, platform);
  const trafficGuard = new FreeTrafficGuard({
    userRateLimitPerMinute: platform.userRateLimitPerMinute ?? 12,
    ipRateLimitPerMinute: platform.ipRateLimitPerMinute ?? 30,
    globalRateLimitPerMinute: platform.globalRateLimitPerMinute ?? 600,
    globalConcurrency: platform.globalConcurrency ?? 32
  });

  app.post<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId/generations',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const input = generationRequestSchema.parse(request.body);
      const rawIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : '';
      if (!idempotencyKey || idempotencyKey.length > 100) {
        throw new AppError('VALIDATION_ERROR', '缺少有效的 Idempotency-Key。');
      }

      const existing = await database.query<{
        generation_request_id: string;
        status: string;
        content_text: string | null;
      }>(
        `SELECT g.generation_request_id, g.status, m.content_text
         FROM agent_generation_request g
         LEFT JOIN chat_message m ON m.generation_request_id = g.generation_request_id
         WHERE g.user_id = $1 AND g.idempotency_key = $2`,
        [userId, idempotencyKey]
      );
      if (existing.rows[0]) {
        const quota =
          input.usage_mode === 'PLATFORM'
            ? await getFreeQuota(database, userId)
            : null;
        reply.type('text/event-stream; charset=utf-8');
        return reply.send(
          Readable.from([
            sse('done', {
              generation_request_id: existing.rows[0].generation_request_id,
              status: existing.rows[0].status,
              text: existing.rows[0].content_text ?? '',
              replayed: true,
              ...(quota ? { free_quota_remaining: quota.remaining } : {})
            })
          ])
        );
      }

      let provider: string;
      let model: string;
      let baseUrl: string;
      let apiKey: string;
      let modelConfigurationId: string | null = null;
      let maxOutputTokens = 2048;
      let temperature = 0.8;

      if (input.usage_mode === 'PLATFORM') {
        if (platform.freeQuotaEnabled === false) {
          throw new AppError(
            'FREE_SERVICE_DISABLED',
            '官方免费服务当前已关闭。',
            503
          );
        }
        const resolved = resolveCredential({ usageMode: 'PLATFORM', platform });
        provider = resolved.provider;
        model = resolved.model;
        baseUrl = resolved.baseUrl;
        apiKey = resolved.apiKey;
      } else {
        const configuration = await database.query<{
          model_configuration_id: string;
          provider: string;
          model_name: string;
          base_url: string;
          credential_id: string;
          settings_json: { max_output_tokens?: number; temperature?: number } | null;
        }>(
          `SELECT model_configuration_id, provider, model_name, base_url,
                  credential_id, settings_json
           FROM model_configuration
           WHERE model_configuration_id = $1 AND user_id = $2
             AND configuration_scope = 'USER' AND credential_mode = 'BROWSER_LOCAL'
             AND status = 'ACTIVE' AND deleted_at IS NULL`,
          [input.model_configuration_id, userId]
        );
        const config = configuration.rows[0];
        if (!config) throw new AppError('RESOURCE_NOT_FOUND', '模型配置不存在。', 404);
        if (config.credential_id !== input.credential.credential_id) {
          throw new AppError('CREDENTIAL_INVALID', '本地凭证与模型配置不匹配。', 400);
        }
        const resolved = resolveCredential({
          usageMode: 'BYOK',
          platform,
          browserCredential: {
            credentialId: input.credential.credential_id,
            apiKey: input.credential.api_key
          }
        });
        provider = config.provider;
        model = config.model_name;
        baseUrl = config.base_url;
        apiKey = resolved.apiKey;
        modelConfigurationId = config.model_configuration_id;
        maxOutputTokens = config.settings_json?.max_output_tokens ?? maxOutputTokens;
        temperature = config.settings_json?.temperature ?? temperature;
      }

      const conversation = await database.query<{ next_sequence_no: number; next_turn_no: number }>(
        `SELECT next_sequence_no, next_turn_no FROM chat_conversation
         WHERE conversation_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
        [request.params.conversationId, userId]
      );
      if (!conversation.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '会话不存在。', 404);

      // Editing a user message: everything from that message onward leaves the
      // active branch, and the rewritten text starts a new one. The old rows stay
      // in the database (SUPERSEDED) so nothing the user wrote is destroyed.
      let supersedeFromSequenceNo: number | null = null;
      if (input.edit_of_message_id) {
        const edited = await database.query<{ sequence_no: string | number }>(
          `SELECT sequence_no FROM chat_message
           WHERE message_id = $1 AND conversation_id = $2
             AND role = 'USER' AND is_active_variant = TRUE`,
          [input.edit_of_message_id, request.params.conversationId]
        );
        if (!edited.rows[0]) {
          throw new AppError('RESOURCE_NOT_FOUND', '要编辑的消息不存在。', 404);
        }
        supersedeFromSequenceNo = Number(edited.rows[0].sequence_no);
      }

      let releaseTraffic: (() => void) | undefined;
      let quotaReserved = false;
      if (input.usage_mode === 'PLATFORM') {
        releaseTraffic = trafficGuard.enter(userId, request.ip);
        try {
          const reservation = await reserveFreeQuota(
            database,
            userId,
            idempotencyKey
          );
          if (!reservation.acquired) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              '相同请求正在处理中，请稍后重试。',
              409,
              true
            );
          }
          quotaReserved = true;
        } catch (error) {
          releaseTraffic();
          throw error;
        }
      }

      const generationRequestId = randomUUID();
      const inputMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const usageId = randomUUID();
      const sequenceNo = Number(conversation.rows[0].next_sequence_no);
      const turnNo = Number(conversation.rows[0].next_turn_no);
      const rawSessionId = request.headers['x-litetavern-session-id'];
      const clientSessionId =
        typeof rawSessionId === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(rawSessionId)
          ? rawSessionId
          : null;

      await database.exec('BEGIN');
      try {
        if (supersedeFromSequenceNo !== null) {
          await database.query(
            `UPDATE chat_message
             SET is_active_variant = FALSE, status = 'SUPERSEDED',
                 updated_at = CURRENT_TIMESTAMP
             WHERE conversation_id = $1 AND sequence_no >= $2 AND is_active_variant = TRUE`,
            [request.params.conversationId, supersedeFromSequenceNo]
          );
        }
        await database.query(
          `INSERT INTO chat_message (
             message_id, conversation_id, sequence_no, turn_no, role,
             content_text, status, completed_at
           ) VALUES ($1, $2, $3, $4, 'USER', $5, 'COMPLETED', CURRENT_TIMESTAMP)`,
          [inputMessageId, request.params.conversationId, sequenceNo, turnNo, input.input.text]
        );
        await database.query(
          `INSERT INTO agent_generation_request (
             generation_request_id, user_id, conversation_id, input_message_id,
             model_configuration_id, usage_mode, idempotency_key, status,
             prompt_version, provider, model_name, client_session_id, started_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'GENERATING',
             'litetavern-v0.1.0', $8, $9, $10, CURRENT_TIMESTAMP
           )`,
          [
            generationRequestId,
            userId,
            request.params.conversationId,
            inputMessageId,
            modelConfigurationId,
            input.usage_mode,
            idempotencyKey,
            provider,
            model,
            clientSessionId
          ]
        );
        await database.query(
          `INSERT INTO chat_message (
             message_id, conversation_id, generation_request_id, reply_to_message_id,
             sequence_no, turn_no, role, content_text, status
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ASSISTANT', '', 'STREAMING')`,
          [
            assistantMessageId,
            request.params.conversationId,
            generationRequestId,
            inputMessageId,
            sequenceNo + 1,
            turnNo
          ]
        );
        await database.query(
          `INSERT INTO model_usage_ledger (
             usage_id, generation_request_id, user_id, usage_mode,
             provider, model_name, status
           ) VALUES ($1, $2, $3, $4, $5, $6, 'RESERVED')`,
          [usageId, generationRequestId, userId, input.usage_mode, provider, model]
        );
        await database.query(
          `UPDATE chat_conversation
           SET next_sequence_no = $2, next_turn_no = $3,
               last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE conversation_id = $1`,
          [request.params.conversationId, sequenceNo + 2, turnNo + 1]
        );
        await database.exec('COMMIT');
      } catch (error) {
        await database.exec('ROLLBACK');
        if (quotaReserved) {
          await releaseFreeQuota(database, {
            userId,
            requestId: idempotencyKey,
            provider,
            model,
            failureCode: 'REQUEST_SETUP_FAILED'
          });
        }
        releaseTraffic?.();
        throw error;
      }

      const context = await assembleContext(database, userId, request.params.conversationId);
      await database.query(
        `UPDATE agent_generation_request SET context_manifest_json = $2::jsonb
         WHERE generation_request_id = $1`,
        [generationRequestId, JSON.stringify(context.manifest)]
      );

      async function* eventStream() {
        let fullText = '';
        let officialCompletion: Promise<OfficialCompletionMetadata> | null = null;
        try {
          const result =
            input.usage_mode === 'PLATFORM'
              ? await officialRouter.stream({
                  system: context.system,
                  messages: context.messages,
                  maxOutputTokens,
                  temperature
                })
              : await gateway.stream({
                  provider,
                  model,
                  baseUrl,
                  apiKey,
                  system: context.system,
                  messages: context.messages,
                  maxOutputTokens,
                  temperature
                });
          if (input.usage_mode === 'PLATFORM' && 'completion' in result) {
            officialCompletion = result.completion;
          }
          yield sse('start', { generation_request_id: generationRequestId });
          for await (const delta of result.textStream) {
            fullText += delta;
            yield sse('delta', { text: delta });
          }
          const completion = officialCompletion
            ? await officialCompletion
            : null;
          const usage =
            completion?.usage ??
            ('usage' in result
              ? await result.usage
              : { inputTokens: 0, outputTokens: 0 });
          const actualProvider = completion?.provider ?? provider;
          const actualModel = completion?.model ?? model;
          await database.exec('BEGIN');
          try {
            await database.query(
              `UPDATE chat_message
               SET content_text = $2, status = 'COMPLETED', token_count = $3,
                   completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
               WHERE message_id = $1`,
              [assistantMessageId, fullText, usage.outputTokens]
            );
            await database.query(
              `UPDATE agent_generation_request
               SET status = 'COMPLETED', input_tokens = $2, output_tokens = $3,
                   provider = $4, model_name = $5, provider_request_id = $6,
                   latency_ms = $7, fallback_used = $8,
                   provider_attempts_json = $9::jsonb,
                   completed_at = CURRENT_TIMESTAMP
               WHERE generation_request_id = $1`,
              [
                generationRequestId,
                usage.inputTokens,
                usage.outputTokens,
                actualProvider,
                actualModel,
                completion?.providerRequestId ?? null,
                completion?.latencyMs ?? null,
                completion?.fallbackUsed ?? false,
                JSON.stringify(completion?.attempts ?? [])
              ]
            );
            await database.query(
              `UPDATE model_usage_ledger
               SET status = 'FINALIZED', provider = $2, model_name = $3,
                   input_tokens = $4, output_tokens = $5,
                   finalized_at = CURRENT_TIMESTAMP
               WHERE usage_id = $1`,
              [
                usageId,
                actualProvider,
                actualModel,
                usage.inputTokens,
                usage.outputTokens
              ]
            );
            for (const jobType of ['EXTRACT_MEMORY', 'UPDATE_SUMMARY']) {
              await database.query(
                `INSERT INTO system_postprocess_job (
                   job_id, dedupe_key, job_type, generation_request_id, conversation_id
                 ) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (dedupe_key) DO NOTHING`,
                [
                  randomUUID(),
                  `${generationRequestId}:${jobType}`,
                  jobType,
                  generationRequestId,
                  request.params.conversationId
                ]
              );
            }
            await database.exec('COMMIT');
          } catch (error) {
            await database.exec('ROLLBACK');
            throw error;
          }
          const quota =
            input.usage_mode === 'PLATFORM'
              ? await finalizeFreeQuota(database, {
                  userId,
                  requestId: idempotencyKey,
                  provider: actualProvider,
                  model: actualModel
                })
              : null;
          yield sse('done', {
            generation_request_id: generationRequestId,
            message_id: assistantMessageId,
            usage_mode: input.usage_mode,
            usage,
            ...(quota ? { free_quota_remaining: quota.remaining } : {})
          });
        } catch (reason) {
          await officialCompletion?.catch(() => undefined);
          const error =
            reason instanceof AppError
              ? reason
              : input.usage_mode === 'PLATFORM'
                ? new AppError(
                    'FREE_SERVICE_UNAVAILABLE',
                    '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。',
                    503,
                    true
                  )
                : new AppError(
                    'PROVIDER_UNAVAILABLE',
                    '模型服务暂时不可用。',
                    503,
                    true
                  );
          await database.query(
            `UPDATE chat_message SET status = 'FAILED', error_code = $2,
                                     updated_at = CURRENT_TIMESTAMP
             WHERE message_id = $1`,
            [assistantMessageId, error.code]
          );
          await database.query(
            `UPDATE agent_generation_request
             SET status = 'FAILED', error_code = $2,
                 error_message = $3, completed_at = CURRENT_TIMESTAMP
             WHERE generation_request_id = $1`,
            [generationRequestId, error.code, error.message]
          );
          await database.query(
            `UPDATE model_usage_ledger SET status = 'REVERSED', reversed_at = CURRENT_TIMESTAMP
             WHERE usage_id = $1`,
            [usageId]
          );
          if (quotaReserved) {
            await releaseFreeQuota(database, {
              userId,
              requestId: idempotencyKey,
              provider,
              model,
              failureCode: error.code
            });
          }
          yield sse('error', {
            code: error.code,
            message: error.message,
            retryable: error.retryable
          });
        } finally {
          apiKey = '';
          releaseTraffic?.();
        }
      }

      reply
        .header('Cache-Control', 'no-cache, no-transform')
        .header('X-Accel-Buffering', 'no')
        .type('text/event-stream; charset=utf-8');
      return reply.send(Readable.from(eventStream()));
    }
  );

  app.post<{
    Params: { conversationId: string };
    Body: {
      usage_mode?: string;
      model_configuration_id?: string;
      credential?: { credential_id?: string; api_key?: string };
    };
  }>('/v1/conversations/:conversationId/reply-suggestions', async (request) => {
    const userId = await resolveUserId(request, database);
    const body = request.body ?? {};
    const usageMode = body.usage_mode === 'BYOK' ? 'BYOK' : 'PLATFORM';

    const conversation = await database.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM chat_conversation
       WHERE conversation_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [request.params.conversationId, userId]
    );
    if (!conversation.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '会话不存在。', 404);

    let provider: string;
    let model: string;
    let baseUrl: string;
    let apiKey: string;
    if (usageMode === 'PLATFORM') {
      const resolved = resolveCredential({ usageMode: 'PLATFORM', platform });
      provider = resolved.provider;
      model = resolved.model;
      baseUrl = resolved.baseUrl;
      apiKey = resolved.apiKey;
    } else {
      if (!body.model_configuration_id || !body.credential?.credential_id || !body.credential.api_key) {
        throw new AppError('VALIDATION_ERROR', '缺少模型配置或本地凭证。');
      }
      const configuration = await database.query<{
        provider: string;
        model_name: string;
        base_url: string;
        credential_id: string;
      }>(
        `SELECT provider, model_name, base_url, credential_id
         FROM model_configuration
         WHERE model_configuration_id = $1 AND user_id = $2
           AND configuration_scope = 'USER' AND credential_mode = 'BROWSER_LOCAL'
           AND status = 'ACTIVE' AND deleted_at IS NULL`,
        [body.model_configuration_id, userId]
      );
      const config = configuration.rows[0];
      if (!config) throw new AppError('RESOURCE_NOT_FOUND', '模型配置不存在。', 404);
      if (config.credential_id !== body.credential.credential_id) {
        throw new AppError('CREDENTIAL_INVALID', '本地凭证与模型配置不匹配。', 400);
      }
      const resolved = resolveCredential({
        usageMode: 'BYOK',
        platform,
        browserCredential: {
          credentialId: body.credential.credential_id,
          apiKey: body.credential.api_key
        }
      });
      provider = config.provider;
      model = config.model_name;
      baseUrl = config.base_url;
      apiKey = resolved.apiKey;
    }

    const context = await assembleContext(database, userId, request.params.conversationId);
    if (context.messages.length === 0) return { suggestions: [] };

    let suggestions: string[];
    try {
      const raw = await gateway.complete({
        provider,
        model,
        baseUrl,
        apiKey,
        system:
          `${context.system}\n\n[任务] 你要替"用户"想几句可能的回复。基于以上对话，站在【用户】第一人称，` +
          '给出 3 条简短、自然、彼此不同的候选回复。每条不超过 20 字，口语化，不要编号或引号。' +
          '只输出一个 JSON 字符串数组（例如 ["好啊","让我想想","改天吧"]），不要输出任何其他文字。',
        messages: context.messages,
        maxOutputTokens: 200,
        temperature: 0.9
      });
      suggestions = parseSuggestions(raw);
    } catch {
      suggestions = [];
    }
    return { suggestions };
  });

  // ===== Multi-bubble Agent turns =====

  interface TurnTarget {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    modelConfigurationId: string | null;
    maxOutputTokens: number;
    temperature: number;
  }

  // Resolve provider/model/credential and apply the PLATFORM quota, mirroring the
  // SSE generation path so both share the same credential-isolation guarantees.
  async function resolveTurnTarget(
    userId: string,
    input: GenerationRequestInput
  ): Promise<TurnTarget> {
    if (input.usage_mode === 'PLATFORM') {
      if (platform.freeQuotaEnabled === false) {
        throw new AppError(
          'FREE_SERVICE_DISABLED',
          '官方免费服务当前已关闭。',
          503
        );
      }
      const resolved = resolveCredential({ usageMode: 'PLATFORM', platform });
      return {
        provider: resolved.provider,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        modelConfigurationId: null,
        maxOutputTokens: 2048,
        temperature: 0.8
      };
    }
    const configuration = await database.query<{
      model_configuration_id: string;
      provider: string;
      model_name: string;
      base_url: string;
      credential_id: string;
      settings_json: { max_output_tokens?: number; temperature?: number } | null;
    }>(
      `SELECT model_configuration_id, provider, model_name, base_url,
              credential_id, settings_json
       FROM model_configuration
       WHERE model_configuration_id = $1 AND user_id = $2
         AND configuration_scope = 'USER' AND credential_mode = 'BROWSER_LOCAL'
         AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [input.model_configuration_id, userId]
    );
    const config = configuration.rows[0];
    if (!config) throw new AppError('RESOURCE_NOT_FOUND', '模型配置不存在。', 404);
    if (config.credential_id !== input.credential.credential_id) {
      throw new AppError('CREDENTIAL_INVALID', '本地凭证与模型配置不匹配。', 400);
    }
    const resolved = resolveCredential({
      usageMode: 'BYOK',
      platform,
      browserCredential: {
        credentialId: input.credential.credential_id,
        apiKey: input.credential.api_key
      }
    });
    return {
      provider: config.provider,
      model: config.model_name,
      baseUrl: config.base_url,
      apiKey: resolved.apiKey,
      modelConfigurationId: config.model_configuration_id,
      maxOutputTokens: config.settings_json?.max_output_tokens ?? 2048,
      temperature: config.settings_json?.temperature ?? 0.8
    };
  }

  // Generate a whole turn (1–4 bubbles) in a single model call. The bubbles are NOT
  // persisted here — the client reveals them on a fixed cadence and writes each one
  // as it is shown, so an interrupted turn leaves the unseen bubbles out of the DB.
  app.post<{ Params: { conversationId: string } }>(
    '/v1/conversations/:conversationId/turns',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const input = generationRequestSchema.parse(request.body);
      const rawIdempotencyKey = request.headers['idempotency-key'];
      const idempotencyKey =
        typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : '';
      if (!idempotencyKey || idempotencyKey.length > 100) {
        throw new AppError('VALIDATION_ERROR', '缺少有效的 Idempotency-Key。');
      }

      // Replay: return the turn already generated for this key, along with whatever
      // bubbles have already been persisted for it.
      const existing = await database.query<{ generation_request_id: string }>(
        `SELECT generation_request_id FROM agent_generation_request
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );
      if (existing.rows[0]) {
        const turnId = existing.rows[0].generation_request_id;
        const bubbles = await database.query<{ content_text: string }>(
          `SELECT content_text FROM chat_message
           WHERE generation_request_id = $1 AND turn_bubble_no IS NOT NULL
           ORDER BY turn_bubble_no`,
          [turnId]
        );
        const quota =
          input.usage_mode === 'PLATFORM'
            ? await getFreeQuota(database, userId)
            : null;
        return {
          turn_id: turnId,
          messages: bubbles.rows.map((row) => row.content_text),
          replayed: true,
          ...(quota ? { free_quota_remaining: quota.remaining } : {})
        };
      }

      const target = await resolveTurnTarget(userId, input);

      const conversation = await database.query<{ next_sequence_no: number; next_turn_no: number }>(
        `SELECT next_sequence_no, next_turn_no FROM chat_conversation
         WHERE conversation_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
        [request.params.conversationId, userId]
      );
      if (!conversation.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '会话不存在。', 404);

      // Editing a user message: the edited message and everything after it leave the
      // active branch (kept as SUPERSEDED), and the rewritten text starts this turn.
      let supersedeFromSequenceNo: number | null = null;
      if (input.edit_of_message_id) {
        const edited = await database.query<{ sequence_no: string | number }>(
          `SELECT sequence_no FROM chat_message
           WHERE message_id = $1 AND conversation_id = $2
             AND role = 'USER' AND is_active_variant = TRUE`,
          [input.edit_of_message_id, request.params.conversationId]
        );
        if (!edited.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '要编辑的消息不存在。', 404);
        supersedeFromSequenceNo = Number(edited.rows[0].sequence_no);
      }

      let releaseTraffic: (() => void) | undefined;
      let quotaReserved = false;
      if (input.usage_mode === 'PLATFORM') {
        releaseTraffic = trafficGuard.enter(userId, request.ip);
        try {
          const reservation = await reserveFreeQuota(
            database,
            userId,
            idempotencyKey
          );
          if (!reservation.acquired) {
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              '相同请求正在处理中，请稍后重试。',
              409,
              true
            );
          }
          quotaReserved = true;
        } catch (error) {
          releaseTraffic();
          throw error;
        }
      }

      const generationRequestId = randomUUID();
      const inputMessageId = randomUUID();
      const usageId = randomUUID();
      const sequenceNo = Number(conversation.rows[0].next_sequence_no);
      const turnNo = Number(conversation.rows[0].next_turn_no);
      const rawSessionId = request.headers['x-litetavern-session-id'];
      const clientSessionId =
        typeof rawSessionId === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(rawSessionId)
          ? rawSessionId
          : null;

      await database.exec('BEGIN');
      try {
        if (supersedeFromSequenceNo !== null) {
          await database.query(
            `UPDATE chat_message
             SET is_active_variant = FALSE, status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP
             WHERE conversation_id = $1 AND sequence_no >= $2 AND is_active_variant = TRUE`,
            [request.params.conversationId, supersedeFromSequenceNo]
          );
        }
        await database.query(
          `INSERT INTO chat_message (
             message_id, conversation_id, sequence_no, turn_no, role,
             content_text, status, completed_at
           ) VALUES ($1, $2, $3, $4, 'USER', $5, 'COMPLETED', CURRENT_TIMESTAMP)`,
          [inputMessageId, request.params.conversationId, sequenceNo, turnNo, input.input.text]
        );
        await database.query(
          `INSERT INTO agent_generation_request (
             generation_request_id, user_id, conversation_id, input_message_id,
             model_configuration_id, usage_mode, idempotency_key, status,
             prompt_version, provider, model_name, client_session_id, started_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'GENERATING',
             'litetavern-v0.1.0', $8, $9, $10, CURRENT_TIMESTAMP
           )`,
          [
            generationRequestId,
            userId,
            request.params.conversationId,
            inputMessageId,
            target.modelConfigurationId,
            input.usage_mode,
            idempotencyKey,
            target.provider,
            target.model,
            clientSessionId
          ]
        );
        await database.query(
          `INSERT INTO model_usage_ledger (
             usage_id, generation_request_id, user_id, usage_mode,
             provider, model_name, status
           ) VALUES ($1, $2, $3, $4, $5, $6, 'RESERVED')`,
          [usageId, generationRequestId, userId, input.usage_mode, target.provider, target.model]
        );
        await database.query(
          `UPDATE chat_conversation
           SET next_sequence_no = $2, next_turn_no = $3,
               last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE conversation_id = $1`,
          [request.params.conversationId, sequenceNo + 1, turnNo + 1]
        );
        await database.exec('COMMIT');
      } catch (error) {
        await database.exec('ROLLBACK');
        if (quotaReserved) {
          await releaseFreeQuota(database, {
            userId,
            requestId: idempotencyKey,
            provider: target.provider,
            model: target.model,
            failureCode: 'REQUEST_SETUP_FAILED'
          });
        }
        releaseTraffic?.();
        throw error;
      }

      const context = await assembleContext(database, userId, request.params.conversationId);
      await database.query(
        `UPDATE agent_generation_request SET context_manifest_json = $2::jsonb
         WHERE generation_request_id = $1`,
        [generationRequestId, JSON.stringify(context.manifest)]
      );

      let messages: string[];
      let completion: OfficialCompletionMetadata | null = null;
      try {
        let raw: string;
        if (input.usage_mode === 'PLATFORM') {
          const result = await officialRouter.complete({
            system: context.system + MULTI_BUBBLE_INSTRUCTION,
            messages: context.messages,
            maxOutputTokens: target.maxOutputTokens,
            temperature: target.temperature
          });
          raw = result.text;
          completion = result;
        } else {
          raw = await gateway.complete({
            provider: target.provider,
            model: target.model,
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            system: context.system + MULTI_BUBBLE_INSTRUCTION,
            messages: context.messages,
            maxOutputTokens: target.maxOutputTokens,
            temperature: target.temperature
          });
        }
        messages = normalizeTurn(parseModelTurn(raw));
        if (messages.length === 0) throw new Error('EMPTY_TURN_PLAN');
      } catch (reason) {
        const error =
          reason instanceof AppError
            ? reason
            : input.usage_mode === 'PLATFORM'
              ? new AppError(
                  'FREE_SERVICE_UNAVAILABLE',
                  '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。',
                  503,
                  true
                )
              : new AppError(
                  'PROVIDER_UNAVAILABLE',
                  '模型服务暂时不可用。',
                  503,
                  true
                );
        await database.query(
          `UPDATE agent_generation_request
           SET status = 'FAILED', error_code = $2,
               error_message = $3, completed_at = CURRENT_TIMESTAMP
           WHERE generation_request_id = $1`,
          [generationRequestId, error.code, error.message]
        );
        await database.query(
          `UPDATE model_usage_ledger
           SET status = 'REVERSED', reversed_at = CURRENT_TIMESTAMP
           WHERE usage_id = $1`,
          [usageId]
        );
        if (quotaReserved) {
          await releaseFreeQuota(database, {
            userId,
            requestId: idempotencyKey,
            provider: target.provider,
            model: target.model,
            failureCode: error.code
          });
        }
        releaseTraffic?.();
        target.apiKey = '';
        throw error;
      }

      const estimatedOutputTokens = messages.reduce(
        (sum, text) => sum + text.length,
        0
      );
      const inputTokens = completion?.usage.inputTokens ?? 0;
      const outputTokens =
        completion?.usage.outputTokens || estimatedOutputTokens;
      const actualProvider = completion?.provider ?? target.provider;
      const actualModel = completion?.model ?? target.model;
      try {
        await database.query(
          `UPDATE agent_generation_request
           SET status = 'COMPLETED', input_tokens = $2, output_tokens = $3,
               provider = $4, model_name = $5, provider_request_id = $6,
               latency_ms = $7, fallback_used = $8,
               provider_attempts_json = $9::jsonb,
               completed_at = CURRENT_TIMESTAMP
           WHERE generation_request_id = $1`,
          [
            generationRequestId,
            inputTokens,
            outputTokens,
            actualProvider,
            actualModel,
            completion?.providerRequestId ?? null,
            completion?.latencyMs ?? null,
            completion?.fallbackUsed ?? false,
            JSON.stringify(completion?.attempts ?? [])
          ]
        );
        await database.query(
          `UPDATE model_usage_ledger
           SET status = 'FINALIZED', provider = $2, model_name = $3,
               input_tokens = $4, output_tokens = $5,
               finalized_at = CURRENT_TIMESTAMP
           WHERE usage_id = $1`,
          [usageId, actualProvider, actualModel, inputTokens, outputTokens]
        );
        const quota =
          input.usage_mode === 'PLATFORM'
            ? await finalizeFreeQuota(database, {
                userId,
                requestId: idempotencyKey,
                provider: actualProvider,
                model: actualModel
              })
            : null;

        reply.code(201);
        return {
          turn_id: generationRequestId,
          usage_mode: input.usage_mode,
          messages,
          ...(quota ? { free_quota_remaining: quota.remaining } : {})
        };
      } catch (error) {
        if (quotaReserved) {
          await releaseFreeQuota(database, {
            userId,
            requestId: idempotencyKey,
            provider: actualProvider,
            model: actualModel,
            failureCode: 'FINALIZATION_FAILED'
          });
        }
        throw error;
      } finally {
        releaseTraffic?.();
        target.apiKey = '';
      }
    }
  );

  // Persist a single bubble at the moment the client displays it ("show one, write
  // one"). Idempotent on the client-supplied message_id so a retry never duplicates.
  app.post<{ Params: { conversationId: string; turnId: string } }>(
    '/v1/conversations/:conversationId/turns/:turnId/bubbles',
    async (request, reply) => {
      const userId = await resolveUserId(request, database);
      const body = turnBubbleSchema.parse(request.body);

      const turn = await database.query<{ turn_no: string | number }>(
        `SELECT m.turn_no
         FROM agent_generation_request g
         JOIN chat_message m ON m.message_id = g.input_message_id
         WHERE g.generation_request_id = $1 AND g.user_id = $2
           AND g.conversation_id = $3 AND g.status = 'COMPLETED'`,
        [request.params.turnId, userId, request.params.conversationId]
      );
      if (!turn.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '回合不存在。', 404);
      const turnNo = Number(turn.rows[0].turn_no);

      let sequenceNo: number | null;
      let created = false;
      await database.exec('BEGIN');
      try {
        const conv = await database.query<{ next_sequence_no: number }>(
          `SELECT next_sequence_no FROM chat_conversation
           WHERE conversation_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
          [request.params.conversationId, userId]
        );
        if (!conv.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '会话不存在。', 404);
        const seq = Number(conv.rows[0].next_sequence_no);

        const inserted = await database.query<{ message_id: string }>(
          `INSERT INTO chat_message (
             message_id, conversation_id, generation_request_id, sequence_no, turn_no,
             variant_no, role, content_text, status, turn_bubble_no, completed_at
           ) VALUES ($1, $2, $3, $4, $5, 0, 'ASSISTANT', $6, 'COMPLETED', $7, CURRENT_TIMESTAMP)
           ON CONFLICT (message_id) DO NOTHING
           RETURNING message_id`,
          [
            body.message_id,
            request.params.conversationId,
            request.params.turnId,
            seq,
            turnNo,
            body.text,
            body.bubble_no
          ]
        );

        if (inserted.rows[0]) {
          created = true;
          sequenceNo = seq;
          await database.query(
            `UPDATE chat_conversation
             SET next_sequence_no = $2, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE conversation_id = $1`,
            [request.params.conversationId, seq + 1]
          );
          for (const jobType of ['EXTRACT_MEMORY', 'UPDATE_SUMMARY']) {
            await database.query(
              `INSERT INTO system_postprocess_job (
                 job_id, dedupe_key, job_type, generation_request_id, conversation_id
               ) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (dedupe_key) DO NOTHING`,
              [
                randomUUID(),
                `${request.params.turnId}:${jobType}`,
                jobType,
                request.params.turnId,
                request.params.conversationId
              ]
            );
          }
        } else {
          const priorRow = await database.query<{ sequence_no: number }>(
            `SELECT sequence_no FROM chat_message WHERE message_id = $1`,
            [body.message_id]
          );
          sequenceNo = priorRow.rows[0] ? Number(priorRow.rows[0].sequence_no) : null;
        }
        await database.exec('COMMIT');
      } catch (error) {
        await database.exec('ROLLBACK');
        throw error;
      }

      reply.code(created ? 201 : 200);
      return { message_id: body.message_id, sequence_no: sequenceNo };
    }
  );
}
