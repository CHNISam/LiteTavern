import { describe, expect, it } from 'vitest';
import { resolveProviderEndpoint } from './endpoint-policy.js';

describe('provider endpoint policy', () => {
  it('does not let a fixed preset silently point at another server', () => {
    try {
      resolveProviderEndpoint('deepseek', 'https://evil.example/v1');
      throw new Error('expected policy rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_CONFIGURATION_INVALID' });
    }
  });

  it('allows a user-defined HTTPS OpenAI-compatible endpoint', () => {
    expect(resolveProviderEndpoint('custom-openai', 'https://llm.example.com/v1')).toBe(
      'https://llm.example.com/v1'
    );
  });

  it('rejects non-HTTP protocols', () => {
    try {
      resolveProviderEndpoint('custom-openai', 'file:///etc/passwd');
      throw new Error('expected policy rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_CONFIGURATION_INVALID' });
    }
  });

  it.each([
    'http://[::1]:11434/v1',
    'http://[fc00::1]/v1',
    'http://[fe80::1]/v1',
    'https://llm.example.com/v1?target=internal',
    'https://llm.example.com/v1#fragment'
  ])('rejects unsafe custom endpoint %s', (endpoint) => {
    expect(() => resolveProviderEndpoint('custom-openai', endpoint)).toThrowError();
  });
});
