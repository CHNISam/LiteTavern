/**
 * What happens to a message Cloud refused because this tab's head was stale.
 *
 * Observed on the dev deployment, in the browser: after one upstream failure the very
 * next message vanished. No error, no text left in the composer, no reply — and the
 * message after *that* went through normally. It read as "the character sometimes
 * ignores you", which is why it survived several rounds of looking somewhere else.
 *
 * The mechanism is entirely on this side. A tab only learns the conversation head
 * from a *successful* read, so any turn that fails after the server's head has moved
 * leaves this tab holding a stale one. The next send carries that stale head,
 * `POST /generations` answers 409 HEAD_MISMATCH, and the client used to drop the
 * optimistic row, re-read the transcript, and return — discarding text the reader had
 * typed and Cloud had never seen.
 *
 * HEAD_MISMATCH is refused before any write: the store compares the head and returns
 * without touching the conversation. So unlike DUPLICATE_MESSAGE — which means the
 * text *did* land and must never be sent twice — a refused send is safe, and required,
 * to repeat once the head is current.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetLoreDatabaseForTests } from './lib/lore-store';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const CLOUD_STATUS = {
  cloud: {
    contract_version: 2,
    capabilities: {
      auth: true,
      asset_sync: true,
      platform_generation: true,
      client_turn_sync: true,
      reply_suggestions: true
    },
    stage: 'ALPHA',
    account_state: 'ALPHA',
    email_verified: true,
    platform_models_available: true,
    block_reason: null,
    byok_available: true,
    alpha: {
      active_batch: 1,
      cumulative_capacity: 10,
      remaining_capacity: 3,
      batch_no: 1,
      activated_at: '2026-08-01T00:00:00.000Z',
      promotion_expires_at: null
    },
    waitlist: { on_waitlist: false, joined_at: null },
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
    },
    support: { enabled: false, url: '', headline: '', body: '' }
  }
};

const GREETING = {
  message_id: 'greeting-1',
  role: 'ASSISTANT',
  content_text: '你也来看星星吗？',
  status: 'COMPLETED'
};

/** The turn that failed earlier, already on the server and unknown to this tab. */
const MOVED_ON = {
  message_id: 'assistant-earlier',
  role: 'ASSISTANT',
  content_text: '（刚才那条回复其实已经写下了。）',
  status: 'COMPLETED'
};

function mockCloud(options: { refusals: number }) {
  const encoder = new TextEncoder();
  const generationBodies: Record<string, unknown>[] = [];
  let refusalsLeft = options.refusals;
  let streamed = false;

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (path === '/v1/cloud/status') return json(CLOUD_STATUS);
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/auth/me') return json({ user: {
      user_id: 'user-1', anonymous_id: 'user-1', identity_type: 'EMAIL',
      email: 'a@example.com', registered: true
    } });
    if (path === '/v1/identities/anonymous') return json({ user: {
      user_id: 'user-1', anonymous_id: 'anonymous-1', identity_type: 'ANONYMOUS',
      email: null, registered: false
    } });
    if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
    if (path === '/v1/characters') {
      return json({ characters: [{
        character_id: 'firefly', name: '流萤',
        profile_summary: '星际和平公司成员', personality_summary: '外柔内坚',
        first_message: '你也来看星星吗？', avatar_seed: 'firefly',
        is_owned: true, last_message: null
      }] });
    }
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') {
      // The head the server reports moves the moment it refuses: that read is how
      // the client is supposed to catch up.
      const messages = streamed
        ? [GREETING, MOVED_ON,
           { message_id: 'user-1', role: 'USER', content_text: '你好', status: 'COMPLETED' },
           { message_id: 'assistant-1', role: 'ASSISTANT', content_text: '我也是。', status: 'COMPLETED' }]
        : refusalsLeft < options.refusals
          ? [GREETING, MOVED_ON]
          : [GREETING];
      return json({
        messages,
        conversation: { current_head_id: messages.at(-1)?.message_id ?? null }
      });
    }
    if (path === '/v1/conversations/conversation-1/generations') {
      generationBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (refusalsLeft > 0) {
        refusalsLeft -= 1;
        return json({ error: {
          code: 'HEAD_MISMATCH',
          message: '这个会话在别处已经继续了，请刷新后再发送。',
          retryable: false
        } }, 409);
      }
      streamed = true;
      return Promise.resolve(new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: start\ndata: {"generation_request_id":"gen-1"}\n\n' +
              'event: delta\ndata: {"text":"我也是。"}\n\n' +
              'event: done\ndata: {"generation_request_id":"gen-1","message_id":"assistant-1"}\n\n'
            ));
            controller.close();
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      ));
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });

  return generationBodies;
}

async function sendHello() {
  const composer = await screen.findByPlaceholderText(/流萤/);
  fireEvent.change(composer, { target: { value: '你好' } });
  fireEvent.click(screen.getByRole('button', { name: /发送消息|Send message/ }));
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

it('sends again on the refreshed head instead of swallowing the message', async () => {
  const bodies = mockCloud({ refusals: 1 });

  render(<App />);
  await sendHello();

  // The reader's message survives. Before the fix it was removed from the transcript
  // and never re-sent, so the only trace of it was the empty composer.
  await screen.findByText('你好', { selector: '.message-bubble' });
  await screen.findByText('我也是。', { selector: '.message-bubble' });

  await waitFor(() => expect(bodies).toHaveLength(2));
  // The retry is what the first send should have been: same text, current head.
  expect(bodies[0]?.expected_head_id).toBe('greeting-1');
  expect(bodies[1]?.expected_head_id).toBe('assistant-earlier');
});

it('gives up after one retry rather than re-sending forever', async () => {
  // A head that keeps moving is a conversation being written from somewhere else.
  // Repeating into that is how one tap becomes an unbounded spend.
  const bodies = mockCloud({ refusals: 5 });

  render(<App />);
  await sendHello();

  await waitFor(() => expect(bodies).toHaveLength(2));
  // Held for a moment: a third body would only appear after the second refusal has
  // been handled, and asserting immediately would pass before that could happen.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(bodies).toHaveLength(2);
});
