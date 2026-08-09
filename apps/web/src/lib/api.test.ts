import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, readApiJson, streamGeneration } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API response handling', () => {
  it('turns an empty Pages response into a readable Cloud availability error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    await expect(api('/v1/characters')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INVALID_API_RESPONSE',
      retryable: true,
      message: 'LiteTavern Cloud 暂不可用，请稍后重试。'
    });
  });

  it('does not expose an HTML proxy response as a JSON parsing exception', async () => {
    const response = new Response('<!doctype html><title>Not Found</title>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' }
    });

    await expect(readApiJson(response)).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: 'ApiError',
        code: 'INVALID_API_RESPONSE',
        retryable: true,
        message: 'LiteTavern Cloud 暂不可用，请稍后重试。'
      })
    );
  });

  it('parses split CRLF and multiline SSE frames without dropping or duplicating text', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of [
              'event: start\r\ndata: {"generation_request_id":"generation-1"}\r\n\r\n',
              'event: delta\r\ndata: {"text":"你',
              '好"}\r\n\r\nevent: delta\r\ndata: {"text":"，世界"}\r\n\r\n',
              // A done frame whose data field spans several lines, split across
              // network chunks: the quota block is long enough that a real server
              // may well deliver it this way.
              'event: done\r\ndata: {"message_id":"message-1",\r\n',
              'data: "quota":{"period_limit":1500,"period_used":41,\r\n',
              'data: "period_reserved":0,"period_remaining":1459,\r\n',
              'data: "period_started_at":"2026-08-01T00:00:00.000Z",\r\n',
              'data: "period_ends_at":"2026-08-31T00:00:00.000Z",\r\n',
              'data: "daily_limit":200,"daily_used":9,"daily_reserved":0,\r\n',
              'data: "daily_remaining":191,"day_utc":"2026-08-06"}}\r\n\r\n'
            ]) controller.enqueue(encoder.encode(chunk));
            controller.close();
          }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    );
    const deltas: string[] = [];

    await expect(
      streamGeneration('conversation-1', { input: { type: 'text', text: '你好' } }, {
        idempotencyKey: 'turn-1',
        onDelta: (text) => deltas.push(text)
      })
    ).resolves.toEqual({
      generationRequestId: 'generation-1',
      messageId: 'message-1',
      quota: {
        period_limit: 1500,
        period_used: 41,
        period_reserved: 0,
        period_remaining: 1459,
        period_started_at: '2026-08-01T00:00:00.000Z',
        period_ends_at: '2026-08-31T00:00:00.000Z',
        daily_limit: 200,
        daily_used: 9,
        daily_reserved: 0,
        daily_remaining: 191,
        day_utc: '2026-08-06'
      }
    });
    expect(deltas).toEqual(['你好', '，世界']);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/v1/conversations/conversation-1/generations',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'turn-1' })
      })
    );
  });

  it('forwards AbortSignal so Stop generation cancels the active request', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('Aborted', 'AbortError');
    });

    const pending = streamGeneration('conversation-1', {}, {
      signal: controller.signal,
      onDelta: () => undefined
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('deduplicates replayed sequence numbers without deduplicating repeated text', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: start\ndata: {"generation_request_id":"generation-1"}\n\n' +
              'event: delta\ndata: {"seq":1,"text":"ha"}\n\n' +
              'event: delta\ndata: {"seq":1,"text":"ha"}\n\n' +
              'event: delta\ndata: {"seq":2,"text":"ha"}\n\n' +
              'event: done\ndata: {"message_id":"message-1"}\n\n'
            ));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );
    const deltas: string[] = [];

    await streamGeneration('conversation-1', {}, {
      onDelta: (text) => deltas.push(text)
    });

    expect(deltas).toEqual(['ha', 'ha']);
  });

  it('rejects a conflicting replay of an existing sequence number', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: delta\ndata: {"seq":1,"text":"first"}\n\n' +
              'event: delta\ndata: {"seq":1,"text":"different"}\n\n'
            ));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );

    await expect(
      streamGeneration('conversation-1', {}, { onDelta: () => undefined })
    ).rejects.toMatchObject({
      name: 'ApiError',
      code: 'STREAM_PROTOCOL_CORRUPTED',
      retryable: false
    });
  });

  it('returns a content-free diagnostic trace when capture is enabled', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: start\ndata: {"generation_request_id":"generation-1"}\n\n' +
              'event: delta\ndata: {"seq":1,"text":"private reply"}\n\n' +
              'event: trace\ndata: {"trace_version":1,"provider":"test","model":"model"}\n\n' +
              'event: done\ndata: {"message_id":"message-1"}\n\n'
            ));
            controller.close();
          }
        }),
        { status: 200 }
      )
    );

    const result = await streamGeneration('conversation-1', {}, {
      captureTrace: true,
      onDelta: () => undefined
    });

    expect(result.diagnosticTrace).toMatchObject({
      trace_version: 1,
      generation_request_id: 'generation-1',
      server: { provider: 'test', model: 'model' },
      client: {
        delta_count: 1,
        assembled: { length: 13, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
      }
    });
    expect(JSON.stringify(result.diagnosticTrace)).not.toContain('private reply');
  });
});

describe('semantic generation SSE', () => {
  it('buffers arbitrary chunks and returns one complete canonical turn', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of [
            'event: start\ndata: {"generation_request_id":"turn-1"}\n\n',
            'event: turn\ndata: {"protocol_version":1,"turn_id":"turn-1","actions":[',
            '{"action_id":"message-1","type":"text","content":"Hey."},',
            '{"action_id":"message-2","type":"text","content":"Still there?"}]}\n\n',
            'event: done\ndata: {"generation_request_id":"turn-1","message_id":"message-2"}\n\n'
          ]) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      }),
      { status: 200 }
    ));
    const onDelta = vi.fn();

    const result = await streamGeneration(
      'conversation-1',
      { response_protocol: 'semantic_actions_v1' },
      { onDelta }
    );

    expect(onDelta).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      generationRequestId: 'turn-1',
      messageId: 'message-2',
      turn: {
        protocol_version: 1,
        turn_id: 'turn-1',
        actions: [
          { action_id: 'message-1', type: 'text', content: 'Hey.' },
          { action_id: 'message-2', type: 'text', content: 'Still there?' }
        ]
      }
    });
  });

  it('rejects an invalid semantic turn before runtime delivery', async () => {
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: turn\ndata: {"protocol_version":1,"turn_id":"turn-1","actions":[]}\n\n'
          ));
          controller.close();
        }
      }),
      { status: 200 }
    ));

    await expect(streamGeneration('conversation-1', {}, {})).rejects.toMatchObject({
      code: 'STREAM_PROTOCOL_CORRUPTED',
      retryable: false
    });
  });
});
