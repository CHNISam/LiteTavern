import { z } from 'zod';

export const usageModeSchema = z.enum(['PLATFORM', 'BYOK']);
export type UsageMode = z.infer<typeof usageModeSchema>;

// Email + 6-digit code is the single sign-in/sign-up primitive. Emails are
// normalized (trimmed, lowercased) before any hashing, lookup or uniqueness
// check so "User@Example.com " and "user@example.com" resolve to one account.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  return normalized.length <= 320 && EMAIL_PATTERN.test(normalized);
}

const emailFieldSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => isValidEmail(value), { message: '邮箱格式不正确。' });

export const emailCodeSendSchema = z
  .object({ email: emailFieldSchema })
  .strict();
export type EmailCodeSendInput = z.infer<typeof emailCodeSendSchema>;

export const emailCodeVerifySchema = z
  .object({
    email: emailFieldSchema,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, { message: '验证码为 6 位数字。' })
  })
  .strict();
export type EmailCodeVerifyInput = z.infer<typeof emailCodeVerifySchema>;

export const transientCredentialSchema = z
  .object({
    credential_id: z.string().min(1).max(100),
    api_key: z.string().min(1).max(16_384)
  })
  .strict();

export const textInputSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().trim().min(1).max(32_000)
  })
  .strict();

// Editing a user message re-sends it: the edited message and everything after it
// leave the active branch, and this turn continues from the rewritten text.
const editOfMessageIdSchema = z.uuid().optional();

const platformGenerationSchema = z
  .object({
    usage_mode: z.literal('PLATFORM'),
    input: textInputSchema,
    edit_of_message_id: editOfMessageIdSchema
  })
  .strict();

const byokGenerationSchema = z
  .object({
    usage_mode: z.literal('BYOK'),
    model_configuration_id: z.uuid(),
    input: textInputSchema,
    credential: transientCredentialSchema,
    edit_of_message_id: editOfMessageIdSchema
  })
  .strict();

export const generationRequestSchema = z.discriminatedUnion('usage_mode', [
  platformGenerationSchema,
  byokGenerationSchema
]);
export type GenerationRequestInput = z.infer<typeof generationRequestSchema>;

// One displayed bubble of an Agent turn, persisted at the moment it is shown. The
// client-supplied message_id makes the write idempotent under retries; bubble_no is
// the 1-based ordinal within the turn (capped to MAX_MESSAGES_PER_TURN).
export const turnBubbleSchema = z
  .object({
    message_id: z.uuid(),
    text: z.string().trim().min(1).max(32_000),
    bubble_no: z.number().int().min(1).max(4)
  })
  .strict();
export type TurnBubbleInput = z.infer<typeof turnBubbleSchema>;

export const providerConnectionValidationSchema = z
  .object({
    provider: z.string().min(1),
    base_url: z.url().or(z.literal('')),
    model: z.string().min(1).max(200),
    credential: transientCredentialSchema
  })
  .strict();
export type ProviderConnectionValidationInput = z.infer<
  typeof providerConnectionValidationSchema
>;

export const modelConfigurationInputSchema = z
  .object({
    provider: z.string().min(1),
    display_name: z.string().trim().min(1).max(100),
    model_name: z.string().trim().min(1).max(200),
    base_url: z.url().or(z.literal('')),
    credential_id: z.string().min(1).max(100),
    settings: z
      .object({
        temperature: z.number().min(0).max(2).default(0.8),
        max_output_tokens: z.number().int().min(64).max(32_768).default(2048)
      })
      .default({ temperature: 0.8, max_output_tokens: 2048 })
  })
  .strict();
export type ModelConfigurationInput = z.infer<typeof modelConfigurationInputSchema>;

// Structural events emitted by the client on every session, plus the support-page
// events the marketing surface emits.
const BASE_ANALYTICS_EVENTS = [
  'app_session_started',
  'page_view',
  'critical_action',
  'core_blocking_error_shown',
  'support_page_view',
  'support_method_click',
  'support_qr_view'
] as const;

/**
 * LiteTavern Cloud program events. These are named facts about identity, quota and
 * entitlement rather than free-form interactions, because the funnel questions the
 * business needs answered (trial → registration → waitlist → Alpha activation, and
 * what happens when quota runs out) must be countable without parsing action strings.
 *
 * Lifecycle events that only the server can witness (a grant, a batch, a quota cycle
 * reset, a backup) are emitted server-side; the rest come from the client. None of
 * them may carry chat content, verification codes, full emails or API keys — the
 * property-name guard below rejects those outright.
 */
const CLOUD_ANALYTICS_EVENTS = [
  // identity & registration
  'anonymous_created',
  'registration_started',
  'verification_code_sent',
  'registration_completed',
  // trial
  'cloud_trial_granted',
  'cloud_trial_used',
  'cloud_trial_exhausted',
  // alpha waitlist & entitlement
  'alpha_waitlist_joined',
  'alpha_batch_created',
  'alpha_invitation_sent',
  'alpha_granted',
  'alpha_activated',
  'alpha_paused',
  'alpha_ended',
  // alpha quota
  'alpha_quota_granted',
  'alpha_quota_used',
  'alpha_quota_exhausted',
  'alpha_quota_cycle_reset',
  // core product value
  'first_message_sent',
  'memory_generated',
  'memory_recalled',
  'core_memory_loop_completed',
  'return_visit',
  // cloud services
  'cloud_sync_succeeded',
  'cloud_sync_failed',
  'backup_created',
  'restore_completed',
  'restore_failed',
  // byok & support
  'byok_selected',
  'support_entry_viewed',
  'support_entry_clicked',
  'founding_supporter_marked'
] as const;

export const CLOUD_ANALYTICS_EVENT_NAMES = CLOUD_ANALYTICS_EVENTS;

export const analyticsEventNameSchema = z.enum([
  ...BASE_ANALYTICS_EVENTS,
  ...CLOUD_ANALYTICS_EVENTS
]);

export const analyticsSourceChannelSchema = z.enum([
  'direct',
  'github',
  'bilibili',
  'xiaohongshu',
  'mihoyo_forum',
  'search',
  'friend_share',
  'other'
]);

export const analyticsPageNameSchema = z.enum([
  'home',
  'chat',
  'character_detail',
  'character_memories',
  'character_settings',
  'character_create',
  'character_import',
  'relationship_import',
  'model_config',
  'support'
]);

const analyticsPropertyValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

const forbiddenAnalyticsProperty = /(?:api.?key|authorization|access.?token|refresh.?token|password|content.?text|message.?text|request.?body|character.?card)/i;

export const analyticsPropertiesSchema = z
  .record(z.string().min(1).max(80), analyticsPropertyValueSchema)
  .superRefine((properties, context) => {
    for (const key of Object.keys(properties)) {
      if (forbiddenAnalyticsProperty.test(key)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Sensitive or content-bearing analytics properties are not allowed.'
        });
      }
    }
  });

export const analyticsEventSchema = z
  .object({
    event_id: z.uuid(),
    event_name: analyticsEventNameSchema,
    session_id: z.string().min(1).max(100),
    occurred_at: z.iso.datetime({ offset: true }),
    page_name: analyticsPageNameSchema.optional(),
    page_path: z.string().max(500).optional(),
    character_id: z.uuid().optional(),
    conversation_id: z.uuid().optional(),
    source_channel: analyticsSourceChannelSchema.optional(),
    campaign_id: z.string().max(200).optional(),
    properties: analyticsPropertiesSchema.default({})
  })
  .strict()
  .superRefine((event, context) => {
    if (event.event_name === 'app_session_started' && !event.source_channel) {
      context.addIssue({
        code: 'custom',
        path: ['source_channel'],
        message: 'source_channel is required for app_session_started.'
      });
    }
    if (
      ['page_view', 'critical_action', 'core_blocking_error_shown'].includes(
        event.event_name
      ) &&
      !event.page_name
    ) {
      context.addIssue({
        code: 'custom',
        path: ['page_name'],
        message: `page_name is required for ${event.event_name}.`
      });
    }
    if (
      event.event_name === 'critical_action' &&
      typeof event.properties.action_name !== 'string'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['properties', 'action_name'],
        message: 'action_name is required for critical_action.'
      });
    }
    if (
      event.event_name === 'core_blocking_error_shown' &&
      typeof event.properties.error_code !== 'string'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['properties', 'error_code'],
        message: 'error_code is required for core_blocking_error_shown.'
      });
    }
  });

export const analyticsEventBatchSchema = z
  .object({
    events: z.array(analyticsEventSchema).min(1).max(50)
  })
  .strict();

export type AnalyticsEventInput = z.infer<typeof analyticsEventSchema>;
export type AnalyticsEventBatchInput = z.infer<typeof analyticsEventBatchSchema>;

// ===== LiteTavern Cloud =====

export const grantSourceSchema = z.enum([
  'SUPPORTER_PRIORITY',
  'WAITLIST',
  'DIRECT_INVITE',
  'ADMIN_GRANT'
]);
export type GrantSourceInput = z.infer<typeof grantSourceSchema>;

export const cloudWaitlistJoinSchema = z
  .object({ channel: z.string().trim().max(50).optional() })
  .strict();

export const cloudSyncCheckpointSchema = z
  .object({
    device_key: z.string().trim().min(1).max(100),
    status: z.enum(['LOCAL', 'SYNCING', 'SYNCED', 'FAILED']),
    client_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    pending_count: z.number().int().min(0).max(100_000).optional(),
    error_code: z.string().trim().max(80).optional()
  })
  .strict();
export type CloudSyncCheckpointInput = z.infer<typeof cloudSyncCheckpointSchema>;

// Batch capacity and quota policy are operator inputs, never constants in code:
// each Alpha batch can run a different allowance while its size stays adjustable.
export const alphaQuotaPolicySchema = z
  .object({
    cycle_units: z.number().int().min(1).max(1_000_000).optional(),
    cycle_days: z.number().int().min(1).max(365).optional(),
    carry_over: z.boolean().optional(),
    max_units_per_request: z.number().int().min(1).max(1000).optional(),
    daily_unit_limit: z.number().int().min(0).max(1_000_000).optional(),
    user_rate_limit_per_minute: z.number().int().min(1).max(600).optional(),
    model_multipliers: z.record(z.string().min(1).max(200), z.number().positive()).optional()
  })
  .strict();

export const alphaBatchCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    capacity: z.number().int().min(1).max(1_000_000),
    quota_policy: alphaQuotaPolicySchema.optional(),
    budget_limit_usd: z.number().min(0).max(1_000_000).optional(),
    notes: z.string().trim().max(1000).optional()
  })
  .strict();
export type AlphaBatchCreateInput = z.infer<typeof alphaBatchCreateSchema>;

export const alphaBatchUpdateSchema = z
  .object({
    capacity: z.number().int().min(1).max(1_000_000).optional(),
    status: z.enum(['OPEN', 'PAUSED', 'CLOSED']).optional(),
    quota_policy: alphaQuotaPolicySchema.optional(),
    budget_limit_usd: z.number().min(0).max(1_000_000).optional(),
    notes: z.string().trim().max(1000).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少需要一个待更新字段。'
  });
export type AlphaBatchUpdateInput = z.infer<typeof alphaBatchUpdateSchema>;

// Either release specific users (targeted invite) or take the next `count` from the
// waitlist in priority order. Never both: an ambiguous release is a rejected release.
export const alphaReleaseSchema = z
  .object({
    user_ids: z.array(z.uuid()).min(1).max(500).optional(),
    count: z.number().int().min(1).max(500).optional(),
    grant_source: grantSourceSchema.optional()
  })
  .strict()
  .refine(
    (value) => Boolean(value.user_ids) !== Boolean(value.count),
    { message: '请提供 user_ids 或 count 之一。' }
  );
export type AlphaReleaseInput = z.infer<typeof alphaReleaseSchema>;

export const membershipTransitionSchema = z
  .object({
    transition: z.enum(['PAUSE', 'RESUME', 'END']),
    reason: z.string().trim().max(200).optional()
  })
  .strict();

// Founding Supporter is a voluntary-contribution identity, not a purchased tier.
// `external_reference` is the payment-platform reference used to keep marking a
// supporter idempotent; it is never treated as an entitlement to paid features.
export const foundingSupporterSchema = z
  .object({
    user_id: z.uuid(),
    display_name: z.string().trim().max(120).optional(),
    anonymous: z.boolean().optional(),
    external_reference: z.string().trim().max(200).optional(),
    note: z.string().trim().max(300).optional()
  })
  .strict();
export type FoundingSupporterInput = z.infer<typeof foundingSupporterSchema>;
