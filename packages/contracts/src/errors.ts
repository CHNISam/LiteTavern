export const ERROR_CODES = [
  'UNAUTHORIZED',
  'IDENTITY_CONFLICT',
  'CROSS_ORIGIN_REQUEST_REJECTED',
  'RESOURCE_NOT_FOUND',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_EMAIL',
  'CODE_SEND_RATE_LIMITED',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_ATTEMPTS_EXCEEDED',
  'AUTH_MERGE_FAILED',
  'CHARACTER_CARD_INVALID',
  'RELATIONSHIP_IMPORT_INVALID',
  'CHARACTER_CARD_UNSUPPORTED',
  'MODEL_CONFIGURATION_INVALID',
  'CONNECTION_INVALID',
  'CONNECTION_UNAVAILABLE',
  'CONNECTION_RECONNECT_REQUIRED',
  'RUNTIME_ADAPTER_NOT_FOUND',
  'CREDENTIAL_REQUIRED',
  'CREDENTIAL_INVALID',
  'CREDENTIAL_STORE_UNAVAILABLE',
  'CREDENTIAL_VERSION_CONFLICT',
  'PLATFORM_QUOTA_EXHAUSTED',
  'FREE_QUOTA_EXHAUSTED',
  'FREE_SERVICE_DISABLED',
  'FREE_SERVICE_UNAVAILABLE',
  'FREE_RATE_LIMITED',
  // LiteTavern Cloud. A spent Trial keeps the long-standing FREE_QUOTA_EXHAUSTED
  // code above (same meaning, clients already handle it); a spent Alpha cycle gets
  // its own code because the honest next step differs — wait for the next cycle,
  // switch to BYOK, or use the support entry.
  'CLOUD_QUOTA_EXHAUSTED',
  'CLOUD_QUOTA_DAILY_LIMIT',
  'CLOUD_BUDGET_EXHAUSTED',
  'REGISTRATION_REQUIRED',
  'BATCH_NOT_OPEN',
  // Alpha capacity plan. Separate codes because the honest next step differs: the
  // user has no seat, the program has no free seat, or wave 2 is not yet earned.
  'ALPHA_NOT_GRANTED',
  'ALPHA_CAPACITY_EXHAUSTED',
  'ALPHA_UNLOCK_CONDITIONS_UNMET',
  'PROVIDER_REQUEST_INVALID',
  'PROVIDER_SAFETY_REJECTED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'CONTEXT_TOO_LARGE',
  'GENERATION_CANCELLED',
  'POSTPROCESS_FAILED',
  'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    request_id: string;
  };
}
