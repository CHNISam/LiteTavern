import { describe, expect, it, vi } from 'vitest';
import { createModelProxyFetch } from './model-proxy-fetch.js';

describe('model proxy fetch', () => {
  it('keeps the provider key out of the proxy request headers and response', async () => {
    const providerKey = 'browser-key-test-only';
    const proxyToken = 'gateway-token-test-only';
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${proxyToken}`);
      expect([...headers.values()].join(' ')).not.toContain(providerKey);

      const envelope = JSON.parse(String(init?.body)) as {
        url: string;
        headers: Array<[string, string]>;
        credentialSource: string;
      };
      expect(envelope.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(envelope.headers).toContainEqual(['authorization', `Bearer ${providerKey}`]);
      expect(envelope.credentialSource).toBe('BROWSER_LOCAL');

      return new Response('proxied response', {
        headers: { 'Content-Type': 'text/plain' }
      });
    });

    const proxyFetch = createModelProxyFetch({
      proxyUrl: 'https://pomchat-gateway.example/internal/provider',
      proxyToken,
      fetchImpl: upstreamFetch
    });
    const response = await proxyFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${providerKey}`,
        'Content-Type': 'application/json'
      },
      body: '{"model":"test"}'
    });

    expect(await response.text()).toBe('proxied response');
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });
});
