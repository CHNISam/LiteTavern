import { describe, expect, it } from 'vitest';
import { PROVIDERS, getProvider, providerIds } from './providers.js';

describe('provider registry', () => {
  it('gives every provider a stable unique id', () => {
    expect(new Set(providerIds).size).toBe(PROVIDERS.length);
  });

  it('ships the required domestic providers as first-class presets', () => {
    const domestic = PROVIDERS.filter((provider) => provider.region === 'CN').map(
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
    expect(getProvider('custom-openai').baseUrl).toBe('');
    expect(getProvider('custom-openai').allowCustomBaseUrl).toBe(true);
    expect(getProvider('deepseek').baseUrl).toBe('https://api.deepseek.com');
    expect(getProvider('alibaba').baseUrl).toContain('compatible-mode/v1');
    expect(getProvider('modelscope').baseUrl).toBe('https://api-inference.modelscope.cn/v1');
  });

  it('documents providers with compatibility or migration caveats', () => {
    expect(getProvider('tencent-hunyuan').notice).toContain('TokenHub');
    expect(getProvider('deepseek').notice).toContain('模型列表');
  });
});
