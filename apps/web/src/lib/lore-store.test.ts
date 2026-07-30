import { beforeEach, describe, expect, it } from 'vitest';
import {
  LORE_DB_NAME,
  LORE_STORES,
  getAllLocalRecords,
  mutateLocalAssets,
  openLoreDatabase,
  resetLoreDatabaseForTests
} from './lore-store';

beforeEach(async () => {
  await resetLoreDatabaseForTests();
});

describe('local asset IndexedDB', () => {
  it('creates every versioned store', async () => {
    const database = await openLoreDatabase();
    expect(database.name).toBe(LORE_DB_NAME);
    expect([...database.objectStoreNames]).toEqual(
      expect.arrayContaining([...LORE_STORES])
    );
  });

  it('commits related records atomically', async () => {
    await mutateLocalAssets(['worldbooks', 'worldbook_entries'], (transaction) => {
      transaction.objectStore('worldbooks').put({
        worldbook_id: 'book-1',
        name: 'Book'
      });
      transaction.objectStore('worldbook_entries').put({
        entry_id: 'entry-1',
        worldbook_id: 'book-1'
      });
    });
    expect(await getAllLocalRecords('worldbooks')).toHaveLength(1);
    expect(await getAllLocalRecords('worldbook_entries')).toHaveLength(1);
  });

  it('does not publish a transaction whose request aborts', async () => {
    await expect(
      mutateLocalAssets(['worldbooks', 'worldbook_entries'], (transaction) => {
        transaction.objectStore('worldbooks').put({
          worldbook_id: 'book-1',
          name: 'Book'
        });
        // Missing keyPath aborts the whole transaction.
        transaction.objectStore('worldbook_entries').put({ content: 'bad' });
      })
    ).rejects.toThrow();
    expect(await getAllLocalRecords('worldbooks')).toEqual([]);
  });
});
