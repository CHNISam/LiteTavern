import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, saveAdminToken } from './admin-api';

afterEach(() => {
  vi.unstubAllGlobals();
  saveAdminToken('');
});

describe('adminApi', () => {
  it('sends the operator token only to the Cloud admin API', async () => {
    saveAdminToken('operator-secret');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ alpha: { total_seats: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetcher);

    await adminApi('/api/admin/overview');

    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/overview'),
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          'x-litetavern-admin-token': 'operator-secret'
        })
      })
    );
  });
});
