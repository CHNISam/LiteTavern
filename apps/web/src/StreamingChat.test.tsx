import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetLoreDatabaseForTests } from './lib/lore-store';

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
});

it('renders real SSE deltas and lets the user stop without starting a fallback generation', async () => {
  const requested: string[] = [];
  const encoder = new TextEncoder();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    requested.push(path);
    if (path === '/v1/cloud/status') {
      return json({ cloud: {
        stage: 'ALPHA', platform_models_available: true,
        model_service: { available: true, reason_code: null },
        identity_type: 'ANONYMOUS', registered: false,
        membership_status: 'ANONYMOUS_TRIAL', on_waitlist: false,
        alpha_active: false, alpha_granted: false, founding_supporter: false,
        quota: {
          source: 'TRIAL', total: 30, used: 0, reserved: 0,
          available: 30, remaining_ratio: 1, cycle_no: null,
          cycle_starts_at: null, cycle_ends_at: null
        },
        support: { enabled: false, url: '', headline: '', body: '' },
        next_actions: ['START_CHATTING', 'REGISTER']
      } });
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/identities/anonymous') {
      return json({ user: {
        user_id: 'user-1', anonymous_id: 'anonymous-1',
        identity_type: 'ANONYMOUS', free_quota_remaining: 30,
        free_quota_enabled: true
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
