import { describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest, type WorkerEnv } from './index.js';

const baseEnv: WorkerEnv = {
  BACKEND_ORIGIN: 'https://pomchat-api.example',
  POMCHAT_WEB_ORIGIN: 'https://pomchat.pages.dev',
  POMCHAT_MODEL_PROXY_TOKEN: 'worker-token-test-only'
};

describe('PomChat Cloudflare Worker', () => {
  it('rejects internal provider requests without the shared secret', async () => {
    const fetchImpl = vi.fn();
    const response = await handleWorkerRequest(
      new Request('https://worker.example/internal/provider', {
        method: 'POST',
        body: '{}'
      }),
      baseEnv,
      fetchImpl
    );

    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unsafe provider destinations before making a network request', async () => {
    const fetchImpl = vi.fn();
    const response = await handleWorkerRequest(
      new Request('https://worker.example/internal/provider', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${baseEnv.POMCHAT_MODEL_PROXY_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: 'http://127.0.0.1/admin',
          method: 'POST',
          headers: [],
          body: null,
          credentialSource: 'BROWSER_LOCAL'
        })
      }),
      baseEnv,
      fetchImpl
    );

    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards a BYOK key only to the selected provider and never echoes it', async () => {
    const providerKey = 'browser-key-worker-test-only';
    const fetchImpl = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(request.headers.get('authorization')).toBe(`Bearer ${providerKey}`);
      return new Response('provider stream', {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    });
    const response = await handleWorkerRequest(
      new Request('https://worker.example/internal/provider', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${baseEnv.POMCHAT_MODEL_PROXY_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          headers: [
            ['authorization', `Bearer ${providerKey}`],
            ['content-type', 'application/json']
          ],
          body: '{"model":"test"}',
          credentialSource: 'BROWSER_LOCAL'
        })
      }),
      baseEnv,
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('provider stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify([...response.headers])).not.toContain(providerKey);
  });

  it('reports an unconfigured official provider without forwarding the sentinel', async () => {
    const fetchImpl = vi.fn();
    const response = await handleWorkerRequest(
      new Request('https://worker.example/internal/provider', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${baseEnv.POMCHAT_MODEL_PROXY_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url: 'https://api.openai.com/v1/chat/completions',
          method: 'POST',
          headers: [['authorization', 'Bearer __POMCHAT_PLATFORM_MANAGED__']],
          body: '{}',
          credentialSource: 'PLATFORM_MANAGED'
        })
      }),
      baseEnv,
      fetchImpl
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'PLATFORM_NOT_CONFIGURED' }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('proxies the public API with credentialed CORS for the Pages origin', async () => {
    const fetchImpl = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://pomchat-api.example/v1/characters');
      return new Response('{"characters":[]}', {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'pomchat_anon=test; HttpOnly; Secure; SameSite=Lax'
        }
      });
    });
    const response = await handleWorkerRequest(
      new Request('https://worker.example/v1/characters', {
        headers: { Origin: baseEnv.POMCHAT_WEB_ORIGIN }
      }),
      baseEnv,
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(baseEnv.POMCHAT_WEB_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('set-cookie')).toContain('pomchat_anon=');
  });
});
