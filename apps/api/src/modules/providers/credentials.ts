export interface OfficialProviderTargetConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface PlatformProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  /** Kept for compatibility with existing callers; one-time reply quota supersedes it. */
  dailyTokenQuota: number;
  freeQuotaEnabled?: boolean;
  initialQuota?: number;
  timeoutMs?: number;
  fallback?: OfficialProviderTargetConfig;
  userRateLimitPerMinute?: number;
  ipRateLimitPerMinute?: number;
  globalRateLimitPerMinute?: number;
  globalConcurrency?: number;
}

export interface BrowserCredential {
  credentialId: string;
  apiKey: string;
}

type ResolveCredentialInput =
  | {
      usageMode: 'PLATFORM';
      platform: PlatformProviderConfig;
      browserCredential?: never;
    }
  | {
      usageMode: 'BYOK';
      platform: PlatformProviderConfig;
      browserCredential?: BrowserCredential | undefined;
    };

export type ResolvedCredential =
  | {
      source: 'PLATFORM_MANAGED';
      apiKey: string;
      provider: string;
      model: string;
      baseUrl: string;
    }
  | {
      source: 'BROWSER_LOCAL';
      apiKey: string;
      credentialId: string;
    };

export function resolveCredential(input: {
  usageMode: 'PLATFORM';
  platform: PlatformProviderConfig;
  browserCredential?: never;
}): Extract<ResolvedCredential, { source: 'PLATFORM_MANAGED' }>;
export function resolveCredential(input: {
  usageMode: 'BYOK';
  platform: PlatformProviderConfig;
  browserCredential?: BrowserCredential | undefined;
}): Extract<ResolvedCredential, { source: 'BROWSER_LOCAL' }>;
export function resolveCredential(input: ResolveCredentialInput): ResolvedCredential {
  if (input.usageMode === 'PLATFORM') {
    return {
      source: 'PLATFORM_MANAGED',
      apiKey: input.platform.apiKey,
      provider: input.platform.provider,
      model: input.platform.model,
      baseUrl: input.platform.baseUrl
    };
  }

  if (!input.browserCredential?.apiKey) throw new Error('CREDENTIAL_REQUIRED');
  return {
    source: 'BROWSER_LOCAL',
    apiKey: input.browserCredential.apiKey,
    credentialId: input.browserCredential.credentialId
  };
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum = 0
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function providerFromEnvironment(
  provider: string,
  environment: NodeJS.ProcessEnv
): OfficialProviderTargetConfig {
  if (provider === 'groq') {
    return {
      provider,
      model: environment.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      baseUrl: environment.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      apiKey: environment.GROQ_API_KEY ?? '',
      enabled: booleanValue(environment.GROQ_ENABLED, true)
    };
  }
  if (provider === 'cloudflare') {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID ?? '';
    return {
      provider,
      model:
        environment.CLOUDFLARE_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
      baseUrl:
        environment.CLOUDFLARE_BASE_URL ??
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      apiKey: environment.CLOUDFLARE_API_TOKEN ?? '',
      enabled: booleanValue(environment.CLOUDFLARE_ENABLED, true)
    };
  }
  return {
    provider,
    model: environment.LITETAVERN_PLATFORM_MODEL ?? 'litetavern-demo',
    baseUrl: environment.LITETAVERN_PLATFORM_BASE_URL ?? '',
    apiKey: environment.LITETAVERN_PLATFORM_API_KEY ?? '',
    enabled: true
  };
}

export function loadPlatformProviderConfig(
  environment: NodeJS.ProcessEnv = process.env
): PlatformProviderConfig {
  const primaryName =
    environment.FREE_PROVIDER_PRIMARY ??
    environment.LITETAVERN_PLATFORM_PROVIDER ??
    'groq';
  const fallbackName = environment.FREE_PROVIDER_FALLBACK ?? 'cloudflare';
  const primary = providerFromEnvironment(primaryName, environment);
  const fallback =
    fallbackName && fallbackName !== primaryName
      ? providerFromEnvironment(fallbackName, environment)
      : undefined;
  return {
    ...primary,
    dailyTokenQuota: integerValue(
      environment.LITETAVERN_PLATFORM_DAILY_TOKEN_QUOTA,
      50_000
    ),
    freeQuotaEnabled: booleanValue(environment.FREE_QUOTA_ENABLED, true),
    initialQuota: integerValue(environment.FREE_QUOTA_INITIAL_COUNT, 30),
    timeoutMs: integerValue(environment.FREE_PROVIDER_TIMEOUT_MS, 30_000, 1),
    ...(fallback ? { fallback } : {}),
    userRateLimitPerMinute: integerValue(
      environment.FREE_PROVIDER_USER_RATE_LIMIT_PER_MINUTE,
      12,
      1
    ),
    ipRateLimitPerMinute: integerValue(
      environment.FREE_PROVIDER_IP_RATE_LIMIT_PER_MINUTE,
      30,
      1
    ),
    globalRateLimitPerMinute: integerValue(
      environment.FREE_PROVIDER_GLOBAL_RATE_LIMIT_PER_MINUTE,
      600,
      1
    ),
    globalConcurrency: integerValue(
      environment.FREE_PROVIDER_GLOBAL_CONCURRENCY,
      32,
      1
    )
  };
}
