import { describe, expect, it, vi } from 'vitest';

const streamText = vi.fn();
vi.mock('ai', () => ({ streamText: (...args: unknown[]) => streamText(...args) }));

const { streamByokGeneration } = await import('./byok-client');

function generation() {
  return {
    configuration: {
      model_configuration_id: 'config-1', provider: 'custom-openai', model_name: 'gpt-5-nano',
      display_name: 'Custom', base_url: 'https://api.openai.com/v1',
      credential_id: 'credential-1', credential_configured: true
    },
    apiKey: 'secret',
    character: {
      character_id: 'character-1', name: 'Nova', profile_summary: 'Pilot',
      personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova'
    },
    transcript: [],
    input: 'hi'
  };
}

function stream(deltas: string[]) {
  return {
    textStream: (async function* () {
      for (const delta of deltas) yield delta;
    })()
  };
}

/**
 * The SDK does not throw when a request is refused: it hands the error to
 * `onError` and lets `textStream` finish without a single delta. Returning that
 * silence as a reply is what wrote blank assistant bubbles into the transcript.
 */
describe('browser-direct BYOK stream failures', () => {
  it('raises the error the SDK reported instead of returning an empty reply', async () => {
    streamText.mockImplementation(({ onError }: { onError: (event: { error: unknown }) => void }) => {
      onError({ error: new Error('Invalid prompt: System messages are not allowed') });
      return stream([]);
    });
    await expect(streamByokGeneration(generation())).rejects.toMatchObject({
      code: 'BYOK_DIRECT_PROVIDER_ERROR',
      message: 'Invalid prompt: System messages are not allowed'
    });
  });

  it('treats a reply of nothing as a retryable failure, not as an answer', async () => {
    streamText.mockImplementation(() => stream(['   ']));
    await expect(streamByokGeneration(generation())).rejects.toMatchObject({
      code: 'BYOK_DIRECT_EMPTY_COMPLETION',
      retryable: true
    });
  });

  it('classifies a blocked browser request separately from a provider refusal', async () => {
    streamText.mockImplementation(({ onError }: { onError: (event: { error: unknown }) => void }) => {
      onError({ error: new TypeError('Failed to fetch') });
      return stream([]);
    });
    await expect(streamByokGeneration(generation())).rejects.toMatchObject({
      code: 'BYOK_DIRECT_CORS_BLOCKED',
      retryable: false
    });
  });

  // Stopping a reply is the reader's own decision. Reporting it as a failure
  // would hand them an error for something they asked for.
  it('keeps what arrived before the reader stopped the reply', async () => {
    const controller = new AbortController();
    streamText.mockImplementation(() => {
      controller.abort();
      return stream(['Nova looks up']);
    });
    await expect(
      streamByokGeneration(generation(), { signal: controller.signal })
    ).resolves.toBe('Nova looks up');
  });

  it('returns the streamed reply when the provider answers', async () => {
    streamText.mockImplementation(() => stream(['Nova ', 'waves.']));
    const deltas: string[] = [];
    await expect(
      streamByokGeneration(generation(), { onDelta: (delta) => deltas.push(delta) })
    ).resolves.toBe('Nova waves.');
    expect(deltas).toEqual(['Nova ', 'waves.']);
  });
});
