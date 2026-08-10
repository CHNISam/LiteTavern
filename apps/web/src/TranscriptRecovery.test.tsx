/**
 * What the reader sees after a turn lands.
 *
 * The failure this guards against was observed on a real device: the reply streamed
 * in, the client re-read the conversation to adopt the canonical branch, and the
 * server answered with the character's opening line alone — so the reply, and the
 * message that prompted it, disappeared a moment after arriving. The quota had been
 * spent correctly, which is why it read as a rendering bug rather than a missing
 * write path.
 *
 * The server side is fixed (the transcript is persisted and served by LiteTavern
 * Cloud). This is the client's half of the contract: a server branch that does not
 * contain the turn that just happened is a stale view, not a newer one, and adopting
 * it would delete something the reader watched arrive.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetChatRepositoryForTests } from './lib/chat-repository';
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

/**
 * @param messagesAfterTurn what `GET .../messages` answers once the turn has streamed
 */
function mockCloud(options: {
  messagesAfterTurn: unknown[];
  onConversationBody?: (body: unknown) => void;
}) {
  const encoder = new TextEncoder();
  let streamed = false;

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (path === '/v1/cloud/status') return json(CLOUD_STATUS);
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/auth/me') return json({ user: {
      user_id: 'user-1', anonymous_id: 'user-1', identity_type: 'EMAIL',
      email: 'a@example.com', registered: true
    } });
    if (path === '/v1/identities/anonymous') {
      return json({
        user: {
          user_id: 'user-1',
          anonymous_id: 'anonymous-1',
          identity_type: 'ANONYMOUS',
          email: null,
          registered: false
        }
      });
    }
    if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
    if (path === '/v1/characters') {
      return json({
        characters: [
          {
            character_id: 'firefly',
            name: '流萤',
            profile_summary: '星际和平公司成员',
            personality_summary: '外柔内坚',
            first_message: '你也来看星星吗？',
            avatar_seed: 'firefly',
            is_owned: true,
            last_message: null
          }
        ]
      });
    }
    if (path === '/v1/characters/firefly/card') {
      return json({
        normalized_data: {
          name: '流萤',
          description: '星际和平公司成员',
          personality: '外柔内坚',
          scenario: '观景台',
          first_message: '你也来看星星吗？',
          example_messages: '',
          system_prompt: '',
          post_history_instructions: ''
        },
        source_metadata: {
          compatibility_level: 'FORMAL',
          format: 'ccv3',
          container: 'JSON',
          unapplied_fields: []
        },
        warnings: []
      });
    }
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') {
      options.onConversationBody?.(JSON.parse(String(init?.body ?? '{}')));
      return json({ conversation_id: 'conversation-1' }, 201);
    }
    if (path === '/v1/conversations/conversation-1/messages') {
      return json({ messages: streamed ? options.messagesAfterTurn : [GREETING] });
    }
    if (path === '/v1/conversations/conversation-1/generations') {
      streamed = true;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: start\ndata: {"generation_request_id":"gen-1"}\n\n' +
                    'event: delta\ndata: {"text":"我也是。"}\n\n' +
                    'event: done\ndata: {"generation_request_id":"gen-1","message_id":"assistant-1"}\n\n'
                )
              );
              controller.close();
            }
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      );
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
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
  await resetChatRepositoryForTests();
});

it('adopts the server branch once it contains the turn that just happened', async () => {
  mockCloud({
    messagesAfterTurn: [
      GREETING,
      { message_id: 'user-1', role: 'USER', content_text: '你好', status: 'COMPLETED' },
      {
        message_id: 'assistant-1',
        role: 'ASSISTANT',
        content_text: '我也是。',
        status: 'COMPLETED'
      }
    ]
  });

  render(<App />);
  await sendHello();

  expect(
    await screen.findByText('我也是。', { selector: '.message-bubble' })
  ).toBeInTheDocument();
  expect(screen.getByText('你好', { selector: '.message-bubble' })).toBeInTheDocument();
});

it('keeps the reply when the server branch is missing the turn', async () => {
  // The exact shape of the real-device failure: the transcript read answers with the
  // opening line only, because nothing wrote the turn where the client is looking.
  mockCloud({ messagesAfterTurn: [GREETING] });

  render(<App />);
  await sendHello();

  expect(
    await screen.findByText('我也是。', { selector: '.message-bubble' })
  ).toBeInTheDocument();

  // Give the post-stream read every chance to clobber the view before asserting it
  // did not: the bug was a flash, so an immediate assertion would have passed too.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText('我也是。', { selector: '.message-bubble' })).toBeInTheDocument();
  expect(screen.getByText('你好', { selector: '.message-bubble' })).toBeInTheDocument();
});

it('sends the character card when it opens the conversation', async () => {
  let body: unknown;
  mockCloud({
    messagesAfterTurn: [GREETING],
    onConversationBody: (value) => {
      body = value;
    }
  });

  render(<App />);
  await waitFor(() => expect(body).toBeDefined());

  // Without the card the server has nothing to prompt with: it holds no character
  // store, so `scenario` and the rest would stay fields the app parses and never uses.
  expect(body).toMatchObject({
    character_id: 'firefly',
    card: { name: '流萤', scenario: '观景台', description: '星际和平公司成员' }
  });
});
