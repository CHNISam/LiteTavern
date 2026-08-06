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
    worldbook_id: 'stress-book',
    title: id,
    content: `LORE:${id}`,
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

describe('worldbook activation stress and long-context boundaries', () => {
  it('scans only the configured tail of a 200-message conversation', () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      content_text:
        index === 2
          ? 'ANCIENT_TRIGGER'
          : index === 198
            ? 'RECENT_TRIGGER'
            : `filler-${index}`
    }));

    const scan = buildWorldbookScanText(messages, 20);
    expect(scan).toContain('RECENT_TRIGGER');
    expect(scan).not.toContain('ANCIENT_TRIGGER');

    const result = activateWorldbookEntries(
      [entry('ancient', { keys: ['ANCIENT_TRIGGER'] }), entry('recent', { keys: ['RECENT_TRIGGER'] })],
      messages,
      { activationSeed: 'long-context' }
    );
    expect(result.activated.map(({ entry: item }) => item.entry_id)).toEqual([
      'recent'
    ]);
  });

  it('keeps activation deterministic and bounded with 5,000 candidate entries', () => {
    const entries = Array.from({ length: 5_000 }, (_, index) =>
      entry(`entry-${index}`, {
        keys: index % 50 === 0 ? ['WHITE_HARBOR'] : [`missing-${index}`],
        content: index % 100 === 0 ? 'shared canonical fact' : `fact-${index}`,
        insertion_order: index,
        priority: 5_000 - index
      })
    );
    entries.push(
      entry('disabled-match', {
        keys: ['WHITE_HARBOR'],
        enabled: false,
        priority: 99_999
      })
    );

    const startedAt = performance.now();
    const runs = Array.from({ length: 20 }, () =>
      activateWorldbookEntries(entries, 'WHITE_HARBOR', {
        activationSeed: 'stable-stress-seed',
        maxEntries: 24,
        tokenBudget: 800
      })
    );
    const elapsedMs = performance.now() - startedAt;
    const expectedIds = runs[0]!.activated.map(({ entry: item }) => item.entry_id);

    expect(expectedIds).toHaveLength(24);
    expect(new Set(runs[0]!.activated.map(({ entry: item }) => item.content)).size).toBe(24);
    expect(expectedIds).not.toContain('disabled-match');
    expect(runs.every((run) =>
      JSON.stringify(run.activated.map(({ entry: item }) => item.entry_id)) ===
      JSON.stringify(expectedIds)
    )).toBe(true);
    expect(runs.every((run) => run.tokensUsed <= 800)).toBe(true);
    expect(runs.every((run) => run.activated.length <= 24)).toBe(true);
    // This is intentionally generous enough for shared CI runners while still
    // catching accidental quadratic or unbounded activation work.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('does not duplicate recursively discovered lore in a long noisy context', () => {
    const entries = [
      entry('gate', {
        keys: ['MOON_GATE'],
        content: 'The gate opens toward SILVER_ARCHIVE.',
        insertion_order: 10
      }),
      entry('archive-a', {
        keys: ['SILVER_ARCHIVE'],
        content: 'The archive belongs to the night watch.',
        insertion_order: 20
      }),
      entry('archive-duplicate', {
        keys: ['SILVER_ARCHIVE'],
        content: 'The archive belongs to the night watch.',
        insertion_order: 30
      })
    ];
    const messages = Array.from({ length: 200 }, (_, index) => ({
      content_text: index === 199 ? 'I approach the MOON_GATE.' : `noise-${index}`
    }));

    const result = activateWorldbookEntries(entries, messages, {
      recursive: true,
      activationSeed: 'recursive-long-context'
    });

    expect(result.activated.map(({ entry: item }) => item.entry_id)).toEqual([
      'gate',
      // The higher insertion-order candidate wins the budget-priority sort; the
      // lower-priority duplicate must not be injected as a second copy.
      'archive-duplicate'
    ]);
    expect(result.recursionSteps).toBe(2);
  });
});
