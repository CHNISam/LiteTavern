import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetLoreDatabaseForTests } from './lib/lore-store';
import { resetChatRepositoryForTests } from './lib/chat-repository';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
  await resetChatRepositoryForTests();
});

it('renders real SSE deltas and lets the user stop without starting a fallback generation', async () => {
  const requested: string[] = [];
  const encoder = new TextEncoder();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    requested.push(path);
    if (path === '/v1/cloud/status') {
      return json({ cloud: {
        contract_version: 2,
        capabilities: {
          auth: true, asset_sync: true, platform_generation: true,
          client_turn_sync: true, reply_suggestions: true
        },
        stage: 'ALPHA',
        account_state: 'ALPHA',
        email_verified: true,
        platform_models_available: true,
        block_reason: null,
        byok_available: true,
        alpha: {
          active_batch: 1, cumulative_capacity: 10, remaining_capacity: 3,
          batch_no: 1, activated_at: '2026-08-01T00:00:00.000Z',
          promotion_expires_at: null
        },
        waitlist: { on_waitlist: false, joined_at: null },
        quota: {
          period_limit: 1500, period_used: 41, period_reserved: 0,
          period_remaining: 1459,
          period_started_at: '2026-08-01T00:00:00.000Z',
          period_ends_at: '2026-08-31T00:00:00.000Z',
          daily_limit: 200, daily_used: 9, daily_reserved: 0,
          daily_remaining: 191, day_utc: '2026-08-06'
        },
        support: { enabled: false, url: '', headline: '', body: '' }
      } });
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/auth/me') return json({ user: {
      user_id: 'user-1', anonymous_id: 'user-1', identity_type: 'EMAIL',
      email: 'a@example.com', registered: true
    } });
    if (path === '/v1/identities/anonymous') {
      return json({ user: {
        user_id: 'user-1', anonymous_id: 'anonymous-1',
        identity_type: 'ANONYMOUS', email: null, registered: false
      } });
    }
    if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
    if (path === '/v1/characters') {
      return json({ characters: [{
        character_id: 'nova-card', name: 'Nova', profile_summary: 'Pilot',
        personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova',
        is_owned: true, last_message: null
      }] });
    }
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
    if (path === '/v1/conversations/conversation-1/generations') {
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: start\ndata: {"generation_request_id":"generation-1"}\n\n' +
            'event: delta\ndata: {"text":"partial reply"}\n\n'
          ));
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });

  render(<App />);
  const composer = await screen.findByPlaceholderText(/Nova/);
  fireEvent.change(composer, { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: /发送消息|Send message/ }));

  expect(await screen.findByText('partial reply', { selector: '.message-bubble' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /停止生成|Stop generation/ }));
  await waitFor(() => expect(
    screen.queryByText('partial reply', { selector: '.message-bubble' })
  ).not.toBeInTheDocument());
  expect(requested.some((path) => path.endsWith('/turns'))).toBe(false);
});

it('clears network typing when a slow semantic turn displays one immediate action', async () => {
  const encoder = new TextEncoder();
  let messageReads = 0;
  let elapsedMs = 0;
  let resolveGeneration: ((response: Response) => void) | undefined;
  let markGenerationRequested: (() => void) | undefined;
  const generationRequested = new Promise<void>((resolve) => {
    markGenerationRequested = resolve;
  });
  const generationResponse = new Promise<Response>((resolve) => {
    resolveGeneration = resolve;
  });
  vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    if (path === '/v1/cloud/status') {
      return json({ cloud: {
        contract_version: 2,
        capabilities: {
          auth: true, asset_sync: true, platform_generation: true,
          client_turn_sync: true, reply_suggestions: true
        },
        stage: 'ALPHA',
        account_state: 'ALPHA',
        email_verified: true,
        platform_models_available: true,
        block_reason: null,
        byok_available: true,
        alpha: {
          active_batch: 1, cumulative_capacity: 10, remaining_capacity: 3,
          batch_no: 1, activated_at: '2026-08-01T00:00:00.000Z',
          promotion_expires_at: null
        },
        waitlist: { on_waitlist: false, joined_at: null },
        quota: {
          period_limit: 1500, period_used: 41, period_reserved: 0,
          period_remaining: 1459,
          period_started_at: '2026-08-01T00:00:00.000Z',
          period_ends_at: '2026-08-31T00:00:00.000Z',
          daily_limit: 200, daily_used: 9, daily_reserved: 0,
          daily_remaining: 191, day_utc: '2026-08-06'
        },
        support: { enabled: false, url: '', headline: '', body: '' }
      } });
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/auth/me') return json({ user: {
      user_id: 'user-1', anonymous_id: 'user-1', identity_type: 'EMAIL',
      email: 'a@example.com', registered: true
    } });
    if (path === '/v1/identities/anonymous') {
      return json({ user: {
        user_id: 'user-1', anonymous_id: 'anonymous-1',
        identity_type: 'ANONYMOUS', email: null, registered: false
      } });
    }
    if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
    if (path === '/v1/characters') {
      return json({ characters: [{
        character_id: 'nova-card', name: 'Nova', profile_summary: 'Pilot',
        personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova',
        is_owned: true, last_message: null
      }] });
    }
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') {
      messageReads += 1;
      return json({
        messages: messageReads === 1 ? [] : [{
          message_id: 'message-1', role: 'ASSISTANT',
          content_text: 'settled reply', status: 'COMPLETED'
        }]
      });
    }
    if (path === '/v1/conversations/conversation-1/generations') {
      markGenerationRequested!();
      return generationResponse;
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });

  render(<App />);
  const composer = await screen.findByPlaceholderText(/Nova/);
  fireEvent.change(composer, { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

  await act(async () => {
    await generationRequested;
  });
  expect(document.querySelector('.typing')).toBeInTheDocument();
  elapsedMs = 5_000;
  resolveGeneration!(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: start\ndata: {"generation_request_id":"generation-1"}\n\n' +
        'event: turn\ndata: {"protocol_version":1,"turn_id":"turn-1","actions":[' +
        '{"action_id":"message-1","type":"text","content":"settled reply"}]}\n\n' +
        'event: done\ndata: {"generation_request_id":"generation-1","message_id":"message-1"}\n\n'
      ));
      controller.close();
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } }));

  expect(await screen.findByText('settled reply', { selector: '.message-bubble' }))
    .toBeInTheDocument();
  await waitFor(() => expect(document.querySelector('.typing')).not.toBeInTheDocument());
});
