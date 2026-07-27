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

export const analyticsEventNameSchema = z.enum([
  'app_session_started',
  'page_view',
  'critical_action',
  'core_blocking_error_shown'
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
  'model_config'
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
