import { describe, expect, it } from 'vitest';
import {
  OPENAI_WEB_OAUTH_ENABLED,
  PROVIDERS,
  ProviderRegistry,
  getProvider,
  getProviderRuntimePreset,
  providerIds
} from './providers.js';

describe('provider registry', () => {
  it('gives every provider a stable unique id', () => {
    expect(new Set(providerIds).size).toBe(PROVIDERS.length);
  });

  it('ships the required domestic providers as first-class presets', () => {
    const domestic = PROVIDERS.filter((provider) => provider.category === 'cn').map(
      (provider) => provider.id
    );

    expect(domestic).toEqual(
      expect.arrayContaining([
        'deepseek',
        'alibaba',
        'volcengine',
        'zhipu',
        'moonshot',
        'minimax',
        'siliconflow',
        'baidu-qianfan',
        'tencent-hunyuan',
        'stepfun',
        'modelscope'
      ])
    );
  });

  it('keeps custom endpoints editable and known endpoints prefilled', () => {
    expect(getProviderRuntimePreset('custom-openai').baseUrl).toBe('');
    expect(getProviderRuntimePreset('custom-openai').allowCustomBaseUrl).toBe(true);
    expect(getProviderRuntimePreset('deepseek').baseUrl).toBe('https://api.deepseek.com');
    expect(getProviderRuntimePreset('alibaba').baseUrl).toContain('compatible-mode/v1');
    expect(getProviderRuntimePreset('modelscope').baseUrl).toBe(
      'https://api-inference.modelscope.cn/v1'
    );
  });

  it('documents providers with compatibility or migration caveats', () => {
    expect(getProviderRuntimePreset('tencent-hunyuan').notice).toContain('TokenHub');
    expect(getProviderRuntimePreset('deepseek').notice).toContain('模型列表');
  });

  it('registers multiple independent auth methods for one provider', () => {
    const openai = getProvider('openai');

    expect(openai.authMethods.map((method) => method.id)).toEqual([
      'codex-device-code',
      'codex-cli',
      'api-key'
    ]);
    expect(openai.authMethods.map((method) => method.runtimeAdapterId)).toEqual([
      'openai-codex-app-server',
      'openai-codex-app-server',
      'openai-api'
    ]);
  });

  it('keeps OpenAI Web OAuth disabled and Codex device login scoped to Codex', () => {
    const openai = getProvider('openai');
    const codexDeviceCode = openai.authMethods.find(
      (method) => method.id === 'codex-device-code'
    );

    expect(OPENAI_WEB_OAUTH_ENABLED).toBe(false);
    expect(codexDeviceCode).toMatchObject({
      kind: 'device_code',
      runtimeAdapterId: 'openai-codex-app-server'
    });
    expect(codexDeviceCode?.kind).not.toBe('oauth');
    expect(openai.authMethods).toContainEqual(
      expect.objectContaining({
        id: 'api-key',
        kind: 'api_key',
        runtimeAdapterId: 'openai-api'
      })
    );
  });

  it('does not expose a single protocol or API key requirement on provider definitions', () => {
    const openai = getProvider('openai');

    expect(openai).not.toHaveProperty('protocol');
    expect(openai).not.toHaveProperty('baseUrl');
    expect(openai).not.toHaveProperty('apiKeyRequired');
  });

  it('keeps auth method identifiers unique within each provider', () => {
    for (const provider of PROVIDERS) {
      const ids = provider.authMethods.map((method) => method.id);
      expect(new Set(ids).size, provider.id).toBe(ids.length);
    }
  });

  it('accepts a new provider without changing registry control flow', () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'future-provider',
      displayName: 'Future Provider',
      shortName: 'Future',
      category: 'custom',
      helpUrl: '',
      authMethods: [
        {
          id: 'signed-token',
          kind: 'token',
          runtimeAdapterId: 'future-adapter',
          credentialOwner: 'pomchat',
          display: {
            title: 'Use token',
            description: 'Future auth method',
            group: 'other',
            usesExistingSubscription: false,
            additionalBilling: 'unknown',
            credentialLocation: 'Local secure store',
            modelScope: 'Provider-defined'
          }
        }
      ]
    });

    expect(registry.getAuthMethod('future-provider', 'signed-token').runtimeAdapterId).toBe(
      'future-adapter'
    );
  });
});
