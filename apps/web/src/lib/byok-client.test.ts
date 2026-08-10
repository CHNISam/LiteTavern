import { describe, expect, it } from 'vitest';
import { buildByokMessages } from './byok-client';

describe('browser-direct BYOK prompt', () => {
  it('builds the provider prompt locally and excludes event rows', () => {
    const messages = buildByokMessages({
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
        { message_id: 'event-1', role: 'EVENT', content_text: 'internal', status: 'COMPLETED' },
        { message_id: 'user-1', role: 'USER', content_text: 'Hello', status: 'COMPLETED' }
      ],
      input: 'Are you there?',
      clientContext: { persona: 'Reader' }
    });
    expect(messages).toHaveLength(3);
    expect(JSON.stringify(messages)).toContain('Nova');
    expect(JSON.stringify(messages)).toContain('Reader');
    expect(JSON.stringify(messages)).not.toContain('internal');
    expect(JSON.stringify(messages)).not.toContain('secret');
  });
});
