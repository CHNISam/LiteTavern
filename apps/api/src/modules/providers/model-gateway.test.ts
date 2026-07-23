import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway } from './model-gateway.js';

afterEach(() => vi.unstubAllGlobals());

describe('model gateway validation', () => {
  it('does not turn a failed model-list request into a successful placeholder result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const gateway = createModelGateway();
    await expect(
      gateway.listModels({
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'invalid'
      })
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });
});
