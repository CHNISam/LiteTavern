import { describe, expect, it } from 'vitest';
import {
  activateWorldbookEntries,
  buildWorldbookScanText
} from './worldbook-activation';
import type { WorldbookEntryAsset } from './lore-store';

function entry(
  id: string,
  overrides: Partial<WorldbookEntryAsset> = {}
): WorldbookEntryAsset {
  return {
    entry_id: id,
    worldbook_id: 'book-1',
    title: id,
    content: `content:${id}`,
    keys: [id],
    secondary_keys: [],
    selective: false,
    selective_logic: 'AND_ANY',
    constant: false,
    enabled: true,
    case_sensitive: false,
    match_whole_words: false,
    position: 'AFTER_CHAR',
    insertion_order: 100,
    priority: null,
    probability: 100,
    use_probability: false,
    scan_depth: null,
    depth: 4,
    role: 'system',
    exclude_recursion: false,
    prevent_recursion: false,
    delay_until_recursion: false,
    ...overrides
  };
}

describe('activateWorldbookEntries', () => {
  it('supports constant, primary, and all four secondary-key modes', () => {
    const entries = [
      entry('constant', { constant: true, keys: [] }),
      entry('any', {
        keys: ['harbor'],
        selective: true,
        secondary_keys: ['rain', 'snow'],
        selective_logic: 'AND_ANY'
      }),
      entry('all', {
        keys: ['harbor'],
        selective: true,
        secondary_keys: ['rain', 'night'],
        selective_logic: 'AND_ALL'
      }),
      entry('not-any', {
        keys: ['harbor'],
        selective: true,
        secondary_keys: ['sun'],
        selective_logic: 'NOT_ANY'
      }),
      entry('not-all', {
        keys: ['harbor'],
        selective: true,
        secondary_keys: ['rain', 'sun'],
        selective_logic: 'NOT_ALL'
      })
    ];
    const result = activateWorldbookEntries(entries, 'harbor rain at night');
    expect(result.activated.map((item) => item.entry.entry_id)).toEqual([
      'all',
      'any',
      'constant',
      'not-all',
      'not-any'
    ]);
  });

  it('matches SillyTavern regex keys and respects whole words for plain keys', () => {
    const result = activateWorldbookEntries(
      [
        entry('regex', { keys: ['/white\\s+harbou?r/i'] }),
        entry('plain', { keys: ['art'], match_whole_words: true }),
        entry('inside', { keys: ['art'], match_whole_words: false })
      ],
      'WHITE HARBOR has startling architecture'
    );
    expect(result.activated.map((item) => item.entry.entry_id)).toEqual([
      'inside',
      'regex'
    ]);
  });

  it('uses deterministic probability and still orders winners by insertion order', () => {
    const result = activateWorldbookEntries(
      [
        entry('late', { constant: true, insertion_order: 200 }),
        entry('drop', {
          constant: true,
          probability: 25,
          use_probability: true
        }),
        entry('early', { constant: true, insertion_order: 10 })
      ],
      '',
      { maxEntries: 10, tokenBudget: 1000, random: () => 0.5 }
    );
    expect(result.activated.map((item) => item.entry.entry_id)).toEqual([
      'early',
      'late'
    ]);
  });

  it('recursively activates entries from newly injected worldbook text', () => {
    const result = activateWorldbookEntries(
      [
        entry('first', { keys: ['harbor'], content: 'The Iron Guard watches.' }),
        entry('second', { keys: ['Iron Guard'], content: 'Their captain is Mira.' })
      ],
      'We enter the harbor.',
      { maxEntries: 10, tokenBudget: 1000, recursive: true, maxRecursionSteps: 4 }
    );
    expect(result.activated.map((item) => item.entry.entry_id)).toEqual([
      'first',
      'second'
    ]);
  });

  it('keeps the highest-priority matches inside entry and token budgets', () => {
    const result = activateWorldbookEntries(
      [
        entry('low', { constant: true, priority: 1, content: 'x'.repeat(20) }),
        entry('high', { constant: true, priority: 10, content: 'y'.repeat(20) })
      ],
      '',
      { maxEntries: 1, tokenBudget: 1000 }
    );
    expect(result.activated.map((item) => item.entry.entry_id)).toEqual(['high']);
    expect(result.droppedForBudget).toBe(1);
  });
});

describe('buildWorldbookScanText', () => {
  it('uses the most recent messages and includes pending user text', () => {
    expect(
      buildWorldbookScanText(
        [
          { content_text: 'old' },
          { content_text: 'recent' },
          { content_text: 'latest' }
        ],
        2
      )
    ).toBe('recent\nlatest');
  });
});
