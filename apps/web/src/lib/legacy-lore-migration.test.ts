import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMeta,
  resetLoreDatabaseForTests
} from './lore-store';
import { listPersonas } from './persona';
import {
  LEGACY_CLOUD_MIGRATION_KEY,
  migrateLegacyCloudAssets
} from './legacy-lore-migration';
import { listWorldbooks, readWorldbook } from './worldbook';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await resetLoreDatabaseForTests();
});

describe('legacy Cloud local-asset migration', () => {
  it('treats absent legacy endpoints as not applicable', async () => {
    const fetcher = vi.fn(() => json({}, 404));
    await expect(migrateLegacyCloudAssets(fetcher)).resolves.toEqual({
      status: 'not_applicable'
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('commits all assets once, preserves the old default, and retries cleanly after failure', async () => {
    let failDetail = true;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/v1/personas') {
        return json({
          personas: [
            {
              persona_id: 'cloud-persona',
              name: '旅人',
              description: '来自旧 Cloud',
              is_default: true
            }
          ]
        });
      }
      if (path === '/v1/worldbooks') {
        return json({
          worldbooks: [{ worldbook_id: 'cloud-book', name: '旧设定' }]
        });
      }
      if (path === '/v1/worldbooks/cloud-book' && failDetail) {
        return json({ error: { message: 'temporary' } }, 503);
      }
      return json({
        worldbook: { name: '旧设定', enabled: true },
        entries: [
          {
            entry_id: 'cloud-entry',
            content: '旧世界正文',
            keys: ['旧世界'],
            enabled: true
          }
        ]
      });
    });

    await expect(migrateLegacyCloudAssets(fetcher)).rejects.toThrow(
      /稍后重试/
    );
    expect(await listPersonas()).toEqual([]);
    expect(await listWorldbooks()).toEqual([]);
    expect(await getMeta(LEGACY_CLOUD_MIGRATION_KEY)).toBeNull();

    failDetail = false;
    await expect(migrateLegacyCloudAssets(fetcher)).resolves.toMatchObject({
      status: 'complete',
      personas: 1,
      worldbooks: 1
    });
    const personas = await listPersonas();
    expect(personas).toEqual([
      expect.objectContaining({
        name: '旅人',
        legacy_cloud_id: 'cloud-persona',
        is_default: true
      })
    ]);
    const books = await listWorldbooks();
    expect(books).toEqual([
      expect.objectContaining({
        name: '旧设定',
        origin: 'LEGACY_CLOUD',
        legacy_cloud_id: 'cloud-book'
      })
    ]);
    expect((await readWorldbook(books[0]!.worldbook_id)).entries).toEqual([
      expect.objectContaining({ content: '旧世界正文' })
    ]);

    const callsBefore = fetcher.mock.calls.length;
    await migrateLegacyCloudAssets(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(callsBefore);
  });
});
