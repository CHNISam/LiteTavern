import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamByokGeneration } from './byok-client';

/**
 * The one layer the unit tests cannot reach.
 *
 * A prompt the SDK refuses never becomes an HTTP request at all — and because
 * the refusal is reported to `onError` rather than thrown, the only proof that
 * a turn actually reaches the provider is a server that receives it. This runs
 * the real `streamText` against a local OpenAI-compatible endpoint and reads
 * what came off the wire.
 */

let server: Server | null = null;

function chunk(text: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-5-nano',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
  })}\n\n`;
}

async function startProvider(): Promise<{ origin: string; received: () => unknown }> {
  let body: unknown = null;
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (part) => { raw += part; });
    request.on('end', () => {
      body = JSON.parse(raw);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*'
      });
      response.write(chunk('Nova '));
      response.write(chunk('waves.'));
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, received: () => body };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('browser-direct BYOK wire format', () => {
  it('sends the browser-access header Anthropic requires to allow CORS', async () => {
    let requestHeaders: IncomingMessage['headers'] | null = null;
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      requestHeaders = request.headers;
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'stub' } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    vi.stubEnv('VITE_BYOK_CONNECT_ORIGINS', origin);

    await streamByokGeneration({
      configuration: {
        model_configuration_id: 'config-1', provider: 'anthropic', model_name: 'claude-sonnet-4-20250514',
        display_name: 'Claude', base_url: `${origin}/v1`,
        credential_id: 'credential-1', credential_configured: true
      },
      apiKey: 'test-key',
      character: {
        character_id: 'character-1', name: 'Nova', profile_summary: 'Pilot',
        personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova'
      },
      transcript: [],
      input: 'hi'
    }).catch(() => {});

    expect(requestHeaders?.['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('reaches an OpenAI-compatible provider and returns the streamed reply', async () => {
    const { origin, received } = await startProvider();
    vi.stubEnv('VITE_BYOK_CONNECT_ORIGINS', origin);

    const reply = await streamByokGeneration({
      configuration: {
        model_configuration_id: 'config-1', provider: 'custom-openai', model_name: 'gpt-5-nano',
        display_name: 'Custom', base_url: `${origin}/v1`,
        credential_id: 'credential-1', credential_configured: true
      },
      apiKey: 'test-key',
      character: {
        character_id: 'character-1', name: 'Nova', profile_summary: 'Pilot',
        personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova'
      },
      transcript: [],
      input: 'hi'
    });

    expect(reply).toBe('Nova waves.');

    // The character brief has to arrive as a system message on the wire even
    // though it is no longer a system message in the client's `messages`.
    const body = received() as { messages: { role: string; content: string }[] };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('Nova');
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: 'hi' });
  });
});
