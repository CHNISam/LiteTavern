import { describe, expect, it } from 'vitest';
import { expandMacros, type MacroContext } from './macro-engine';

const context: MacroContext = {
  user: '林岸',
  char: '流萤',
  persona: '夜班记者',
  description: '星核猎手成员',
  personality: '温柔而坚定',
  scenario: '雨夜的白港',
  mesExamples: '<START>\n{{char}}: 要一起走吗？',
  original: '默认系统指令',
  now: new Date('2026-07-30T12:34:56.000Z'),
  locale: 'en-US',
  timeZone: 'UTC'
};

describe('expandMacros', () => {
  it('expands SillyTavern identity and character-card macros case-insensitively', () => {
    expect(
      expandMacros(
        '{{USER}}/{{char}}/{{persona}}/{{description}}/{{personality}}/{{scenario}}',
        context
      )
    ).toBe('林岸/流萤/夜班记者/星核猎手成员/温柔而坚定/雨夜的白港');
  });

  it('expands nested card content with a bounded second pass', () => {
    expect(expandMacros('{{mesExamples}}', context)).toContain('流萤: 要一起走吗？');
  });

  it('expands original once and keeps unknown macros for round-trip compatibility', () => {
    expect(expandMacros('{{original}}\n{{futureMacro}}', context)).toBe(
      '默认系统指令\n{{futureMacro}}'
    );
  });

  it('supports stable utility and ISO time macros', () => {
    expect(
      expandMacros(
        '{{isodate}} {{isotime}}{{newline::2}}x{{space::3}}y',
        context
      )
    ).toBe('2026-07-30 12:34\n\nx   y');
  });

  it('stops recursive macro expansion at the configured pass limit', () => {
    expect(
      expandMacros('{{loop}}', { ...context, dynamic: { loop: '{{loop}}x' } }, 3)
    ).toBe('{{loop}}xxx');
  });
});
