import { describe, expect, it } from 'vitest';
import { resolveCredential, type PlatformProviderConfig } from './modules/providers/credentials.js';

const platform: PlatformProviderConfig = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'platform-secret',
  dailyTokenQuota: 10_000
};

describe('credential isolation', () => {
  it('never accepts a browser key for platform usage', () => {
    const resolved = resolveCredential({ usageMode: 'PLATFORM', platform });
    expect(resolved.apiKey).toBe('platform-secret');
    expect(resolved.source).toBe('PLATFORM_MANAGED');
  });

  it('never falls back to the platform key for BYOK usage', () => {
    expect(() =>
      resolveCredential({ usageMode: 'BYOK', platform, browserCredential: undefined })
    ).toThrow('CREDENTIAL_REQUIRED');
  });

  it('uses only the explicit browser key for BYOK usage', () => {
    const resolved = resolveCredential({
      usageMode: 'BYOK',
      platform,
      browserCredential: { credentialId: 'local-1', apiKey: 'byok-secret' }
    });
    expect(resolved).toMatchObject({
      apiKey: 'byok-secret',
      source: 'BROWSER_LOCAL'
    });
  });
});
