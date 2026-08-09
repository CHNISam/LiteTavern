import { describe, expect, it } from 'vitest';
import fixture from './fixtures/generation-reproduction-v1.json';

describe('chat generation reproduction fixture', () => {
  it('keeps the reviewed four-input cross-client matrix stable', () => {
    expect(fixture).toMatchObject({
      fixture_version: 1,
      turn_inputs: [
        'hey',
        'hey, like you',
        'what are you doing',
        "I'm tired today"
      ],
      usage_modes: ['PLATFORM', 'BYOK'],
      conversation_states: ['NEW', 'EXISTING'],
      clients: ['DESKTOP_BROWSER', 'IPHONE_SAFARI'],
      minimum_repetitions_per_new_conversation: 3,
      long_run_turns: { minimum: 10, maximum: 20 }
    });
  });
});
