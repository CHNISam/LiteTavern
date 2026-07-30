import type { MacroContext } from './macro-engine';

/** Shared input/output vectors mirrored independently in LiteTavern Cloud tests. */
export const MACRO_COMPATIBILITY_FIXTURES: Array<{
  input: string;
  context: MacroContext;
  output: string;
}> = [
  {
    input: '{{user}} meets {{char}}{{newline::2}}{{trim:: ready }}',
    context: { user: 'Lin', char: 'Firefly' },
    output: 'Lin meets Firefly\n\nready'
  },
  {
    input: '{{isodate}} {{isotime}}',
    context: {
      now: new Date('2026-07-30T12:34:56.000Z'),
      locale: 'en-US',
      timeZone: 'UTC'
    },
    output: '2026-07-30 12:34'
  }
];
