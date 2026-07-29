import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, readApiJson } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API response handling', () => {
  it('turns an empty Pages response into a readable Cloud availability error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    await expect(api('/v1/characters')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INVALID_API_RESPONSE',
      retryable: true,
      message: 'LiteTavern Cloud 暂不可用，请稍后重试。'
    });
  });

  it('does not expose an HTML proxy response as a JSON parsing exception', async () => {
    const response = new Response('<!doctype html><title>Not Found</title>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' }
    });

    await expect(readApiJson(response)).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: 'ApiError',
        code: 'INVALID_API_RESPONSE',
        retryable: true,
        message: 'LiteTavern Cloud 暂不可用，请稍后重试。'
      })
    );
  });
});
