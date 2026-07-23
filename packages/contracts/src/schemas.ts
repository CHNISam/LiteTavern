import { z } from 'zod';

export const usageModeSchema = z.enum(['PLATFORM', 'BYOK']);
export type UsageMode = z.infer<typeof usageModeSchema>;

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

const platformGenerationSchema = z
  .object({
    usage_mode: z.literal('PLATFORM'),
    input: textInputSchema
  })
  .strict();

const byokGenerationSchema = z
  .object({
    usage_mode: z.literal('BYOK'),
    model_configuration_id: z.uuid(),
    input: textInputSchema,
    credential: transientCredentialSchema
  })
  .strict();

export const generationRequestSchema = z.discriminatedUnion('usage_mode', [
  platformGenerationSchema,
  byokGenerationSchema
]);
export type GenerationRequestInput = z.infer<typeof generationRequestSchema>;

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
