import { afterEach, describe, expect, it } from 'vitest';
import { resetLoreDatabaseForTests } from './lore-store';
import { resolveClientContext } from './lore-runtime';
import { createPersona } from './persona';
import {
  RegexPlacement,
  saveCharacterRegexBundle
} from './regex-engine';
import {
  createWorldbook,
  createWorldbookEntry,
  setGlobalWorldbooks
} from './worldbook';

afterEach(async () => {
  await resetLoreDatabaseForTests();
});

describe('local turn context', () => {
  it('activates local lore, runs authorized WORLD_INFO Regex, and expands macros deterministically', async () => {
    await createPersona({
      name: '旅人',
      description: '观察者',
      position: 'IN_PROMPT'
    });
    const bookId = await createWorldbook('夜航设定');
    await createWorldbookEntry(bookId, {
      title: '月亮',
      content: 'secret {{char}}',
      keys: ['月亮'],
      constant: false,
      enabled: true,
      position: 'BEFORE_CHAR',
      insertion_order: 8
    });
    await setGlobalWorldbooks([bookId]);
    await saveCharacterRegexBundle(
      'character-1',
      [
        {
          id: 'redact',
          scriptName: '世界书清理',
          findRegex: '/secret/g',
          replaceString: 'redacted',
          placement: [RegexPlacement.WORLD_INFO]
        }
      ],
      true
    );

    const context = await resolveClientContext(
      'character-1',
      'conversation-1',
      [{ role: 'ASSISTANT', content_text: '抬头看看。' }],
      '今晚的月亮很好',
      {
        activationSeed: 'same-turn',
        turnTime: '2026-07-30T12:00:00.000Z',
        macroContext: { char: '星遥' }
      }
    );

    expect(context.payload).toMatchObject({
      version: 1,
      activation_seed: 'same-turn',
      turn_time: '2026-07-30T12:00:00.000Z',
      persona: {
        name: '旅人',
        content: '观察者',
        position: 'IN_PROMPT'
      },
      worldbook_entries: [
        {
          worldbook_id: bookId,
          source: 'GLOBAL',
          content: 'redacted 星遥',
          position: 'BEFORE_CHAR',
          order: 8
        }
      ]
    });
    expect(context.warnings).toEqual([]);
  });

  it('inherits book scan depth and uses the most generous active book budget', async () => {
    const deepBookId = await createWorldbook({
      name: 'Deep lore',
      scan_depth: 6,
      token_budget: 5
    });
    const budgetBookId = await createWorldbook({
      name: 'Budget',
      token_budget: 50
    });
    await createWorldbookEntry(deepBookId, {
      title: 'Old keyword',
      content: 'This entry needs more than five estimated tokens.',
      keys: ['old-keyword'],
      constant: false,
      enabled: true,
      position: 'AFTER_CHAR',
      insertion_order: 10
    });
    await setGlobalWorldbooks([deepBookId, budgetBookId]);

    const context = await resolveClientContext(
      'character-1',
      'conversation-1',
      [
        { role: 'USER', content_text: 'old-keyword' },
        { role: 'ASSISTANT', content_text: 'one' },
        { role: 'USER', content_text: 'two' },
        { role: 'ASSISTANT', content_text: 'three' },
        { role: 'USER', content_text: 'four' }
      ],
      'five',
      {
        activationSeed: 'book-runtime-settings',
        turnTime: '2026-07-30T12:00:00.000Z'
      }
    );

    expect(context.payload.worldbook_entries).toEqual([
      expect.objectContaining({
        worldbook_id: deepBookId,
        content: 'This entry needs more than five estimated tokens.'
      })
    ]);
  });
});
