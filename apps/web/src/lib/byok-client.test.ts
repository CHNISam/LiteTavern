import { describe, expect, it } from 'vitest';
import { buildByokInstructions, buildByokMessages } from './byok-client';

const input = {
  configuration: {
    model_configuration_id: 'config-1', provider: 'openai', model_name: 'gpt-4.1-mini',
    display_name: 'OpenAI', base_url: 'https://api.openai.com/v1',
    credential_id: 'credential-1', credential_configured: true
  },
  apiKey: 'secret',
  character: {
    character_id: 'character-1', name: 'Nova', profile_summary: 'Pilot',
    personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova'
  },
  transcript: [
    { message_id: 'event-1', role: 'EVENT' as const, content_text: 'internal', status: 'COMPLETED' },
    { message_id: 'user-1', role: 'USER' as const, content_text: 'Hello', status: 'COMPLETED' }
  ],
  input: 'Are you there?',
  clientContext: { persona: 'Reader' }
};

describe('browser-direct BYOK prompt', () => {
  it('builds the provider prompt locally and excludes event rows', () => {
    const messages = buildByokMessages(input);
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain('internal');
    expect(JSON.stringify(messages)).not.toContain('secret');
  });

  // The AI SDK refuses a system row inside `messages` and reports the refusal to
  // `onError` instead of throwing, so this mistake does not fail loudly — it
  // produces a stream with no deltas and a blank reply.
  it('carries the character brief as instructions, never as a system message', () => {
    const instructions = buildByokInstructions(input);
    expect(instructions).toContain('Nova');
    expect(instructions).toContain('Reader');
    expect(instructions).not.toContain('secret');
    expect(buildByokMessages(input).some((message) => message.role === 'system')).toBe(false);
  });
});
