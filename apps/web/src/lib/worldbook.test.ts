import { beforeEach, describe, expect, it } from 'vitest';
import {
  exportWorldbook,
  importWorldbook,
  readWorldbook,
  worldbookDraftFromData
} from './worldbook';
import { resetLoreDatabaseForTests } from './lore-store';

beforeEach(async () => {
  await resetLoreDatabaseForTests();
});

describe('SillyTavern World Info interchange', () => {
  it('imports object-keyed entries and maps SillyTavern extension fields', () => {
    const draft = worldbookDraftFromData({
      name: '白港',
      entries: {
        7: {
          uid: 7,
          key: ['白港'],
          keysecondary: ['雨夜'],
          comment: '港口',
          content: '白港终年多雾。',
          order: 321,
          disable: false,
          constant: false,
          selective: true,
          selectiveLogic: 3,
          position: 4,
          depth: 2,
          probability: 75,
          useProbability: true,
          scanDepth: 6,
          excludeRecursion: true,
          custom_field: 'keep-me'
        }
      }
    }, 'fallback');
    expect(draft?.entries?.[0]).toMatchObject({
      title: '港口',
      keys: ['白港'],
      secondary_keys: ['雨夜'],
      selective_logic: 'AND_ALL',
      insertion_order: 321,
      position: 'AT_DEPTH',
      depth: 2,
      probability: 75,
      use_probability: true,
      scan_depth: 6,
      exclude_recursion: true,
      source_fields: { uid: 7, custom_field: 'keep-me' }
    });
  });

  it('round-trips unknown book and entry fields through Character Book export', async () => {
    const imported = await importWorldbook({
      name: 'Book',
      future_book_field: { a: 1 },
      entries: [{
        id: 9,
        keys: ['key'],
        content: 'value',
        insertion_order: 42,
        enabled: true,
        extensions: {
          position: 4,
          depth: 3,
          future_entry_extension: true
        },
        future_entry_field: 'keep'
      }]
    });
    const exported = await exportWorldbook(imported.worldbook_id);
    expect(exported).toMatchObject({
      future_book_field: { a: 1 },
      entries: [{
        future_entry_field: 'keep',
        id: 9,
        content: 'value',
        extensions: {
          position: 4,
          depth: 3,
          future_entry_extension: true
        }
      }]
    });
    expect((await readWorldbook(imported.worldbook_id)).entries).toHaveLength(1);
  });

  it('clamps imported token budgets to the local hard limit', () => {
    expect(
      worldbookDraftFromData(
        {
          name: 'Oversized',
          token_budget: 9_000,
          entries: [{ content: 'value', keys: ['key'] }]
        },
        'fallback'
      )?.token_budget
    ).toBe(8_000);
  });
});
