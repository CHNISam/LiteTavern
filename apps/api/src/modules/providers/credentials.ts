export interface PlatformProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  dailyTokenQuota: number;
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

export function loadPlatformProviderConfig(
  environment: NodeJS.ProcessEnv = process.env
): PlatformProviderConfig {
  const provider = environment.POMCHAT_PLATFORM_PROVIDER ?? 'demo';
  return {
    provider,
    model: environment.POMCHAT_PLATFORM_MODEL ?? 'pomchat-demo',
    baseUrl: environment.POMCHAT_PLATFORM_BASE_URL ?? '',
    apiKey: environment.POMCHAT_PLATFORM_API_KEY ?? '',
    dailyTokenQuota: Number(environment.POMCHAT_PLATFORM_DAILY_TOKEN_QUOTA ?? 50_000)
  };
}
