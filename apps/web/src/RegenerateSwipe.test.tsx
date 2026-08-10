/**
 * Regenerate and swipe, from the reader's side.
 *
 * These two are one feature: regenerate is the only thing that ever produces a second
 * reply to the same message, and swipe is the only thing that makes the first one
 * reachable again. Wiring either without the other gives you a button that quietly
 * destroys an answer, which is what the previous implementation did — it re-sent the
 * user's message as an edit, so the old exchange left the branch and nothing pointed
 * back to it.
 *
 * What is asserted here is the shape of the requests, not just the pixels: the server
 * decides retry-vs-regenerate from the target message's own state, so the client must
 * name the target and nothing else. A regenerate that also carried `input` or a
 * `client_message_id` would be indistinguishable from a second send of a message the
 * reader typed once.
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
    stage: 'ALPHA',
    contract_version: 2,
    capabilities: { auth: true, asset_sync: true, platform_generation: true, client_turn_sync: true, reply_suggestions: true },
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

const USER = {
  message_id: 'user-1',
  role: 'USER',
  content_text: '你好',
  status: 'COMPLETED'
};

/** The transcript with `activeVariant` showing, once two replies exist. */
function branchWith(activeVariant: 1 | 2) {
  const active =
    activeVariant === 1
      ? { message_id: 'assistant-1', content_text: '我也是。', index: 0 }
      : { message_id: 'assistant-2', content_text: '当然，坐下吧。', index: 1 };
  return [
    GREETING,
    USER,
    {
      message_id: active.message_id,
      role: 'ASSISTANT',
      content_text: active.content_text,
      status: 'COMPLETED',
      reply_to_message_id: 'user-1',
      variant: { index: active.index, total: 2 }
    }
  ];
}

interface Recorded {
  generations: Record<string, unknown>[];
  activated: string[];
}

/**
 * A Cloud that actually keeps a branch. `phase` moves forward as the turns land, so a
 * transcript read answers with what the server would answer at that moment rather
 * than with a fixture chosen by the test.
 */
function mockCloud(recorded: Recorded) {
  const encoder = new TextEncoder();
  let phase: 'greeting' | 'answered' | 'regenerated' | 'swiped-back' = 'greeting';

  function transcript() {
    if (phase === 'greeting') return [GREETING];
    if (phase === 'answered') {
      return [
        GREETING,
        USER,
        {
          message_id: 'assistant-1',
          role: 'ASSISTANT',
          content_text: '我也是。',
          status: 'COMPLETED',
          reply_to_message_id: 'user-1'
        }
      ];
    }
    return branchWith(phase === 'regenerated' ? 2 : 1);
  }

  function stream(messageId: string, text: string) {
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: start\ndata: {"generation_request_id":"gen-1"}\n\n' +
                  `event: delta\ndata: ${JSON.stringify({ text })}\n\n` +
                  `event: done\ndata: ${JSON.stringify({
                    generation_request_id: 'gen-1',
                    message_id: messageId
                  })}\n\n`
              )
            );
            controller.close();
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    );
  }

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    if (path === '/v1/cloud/status') return json(CLOUD_STATUS);
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/auth/me') {
      return json({
        user: {
          user_id: 'user-1',
          anonymous_id: 'user-1',
          identity_type: 'EMAIL',
          email: 'a@example.com',
          registered: true
        }
      });
    }
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
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') {
      return json({
        messages: transcript(),
        conversation: { current_head_id: transcript().at(-1)?.message_id ?? null }
      });
    }
    if (path === '/v1/conversations/conversation-1/generations') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      recorded.generations.push(body);
      if (body.regenerate_of_message_id) {
        phase = 'regenerated';
        return stream('assistant-2', '当然，坐下吧。');
      }
      phase = 'answered';
      return stream('assistant-1', '我也是。');
    }
    if (/\/messages\/[^/]+\/variants$/.test(path)) {
      return json({
        answers_message_id: 'user-1',
        variants: [
          {
            message_id: 'assistant-1',
            content_text: '我也是。',
            status: 'COMPLETED',
            variant_no: 0,
            is_active: phase !== 'regenerated'
          },
          {
            message_id: 'assistant-2',
            content_text: '当然，坐下吧。',
            status: 'COMPLETED',
            variant_no: 1,
            is_active: phase === 'regenerated'
          }
        ]
      });
    }
    const activate = /\/messages\/([^/]+)\/activate$/.exec(path);
    if (activate?.[1]) {
      recorded.activated.push(activate[1]);
      phase = activate[1] === 'assistant-1' ? 'swiped-back' : 'regenerated';
      return json({ message: { message_id: activate[1] }, current_head_id: activate[1] });
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
}

async function sendHello() {
  const composer = await screen.findByPlaceholderText(/流萤/);
  fireEvent.change(composer, { target: { value: '你好' } });
  fireEvent.click(screen.getByRole('button', { name: /发送消息|Send message/ }));
  return screen.findByText('我也是。', { selector: '.message-bubble' });
}

function clickRegenerate() {
  fireEvent.click(screen.getByRole('button', { name: /重新生成|Regenerate reply/ }));
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

it('regenerates by naming the reply, not by re-sending the message', async () => {
  const recorded: Recorded = { generations: [], activated: [] };
  mockCloud(recorded);

  render(<App />);
  await sendHello();
  clickRegenerate();

  await waitFor(() => expect(recorded.generations).toHaveLength(2));
  const regeneration = recorded.generations[1]!;
  expect(regeneration.regenerate_of_message_id).toBe('assistant-1');
  // No new user message is being written, so neither of these belongs on the wire.
  // `input` would read as a second send of the same text; `client_message_id` would
  // claim an optimistic row that this turn never created.
  expect(regeneration.input).toBeUndefined();
  expect(regeneration.client_message_id).toBeUndefined();
  // The user's message stays exactly where it was. The old implementation replaced it.
  expect(screen.getByText('你好', { selector: '.message-bubble' })).toBeInTheDocument();
});

it('keeps the earlier reply reachable and swipes back to it', async () => {
  const recorded: Recorded = { generations: [], activated: [] };
  mockCloud(recorded);

  render(<App />);
  await sendHello();
  clickRegenerate();

  expect(
    await screen.findByText('当然，坐下吧。', { selector: '.message-bubble' })
  ).toBeInTheDocument();
  // Two answers now exist, and the reader is looking at the second of them.
  expect(await screen.findByText('2 / 2')).toBeInTheDocument();

  fireEvent.click(
    await screen.findByRole('button', { name: /上一条回复|Previous reply/ })
  );

  await waitFor(() => expect(recorded.activated).toEqual(['assistant-1']));
  expect(
    await screen.findByText('我也是。', { selector: '.message-bubble' })
  ).toBeInTheDocument();
  expect(await screen.findByText('1 / 2')).toBeInTheDocument();
});

it('does not offer to swipe past either end', async () => {
  const recorded: Recorded = { generations: [], activated: [] };
  mockCloud(recorded);

  render(<App />);
  await sendHello();
  clickRegenerate();

  // Showing the last of two: forward is the end of the list. Disabled rather than
  // hidden, so the reader can see there is nothing further rather than watching a
  // control disappear.
  await screen.findByText('2 / 2');
  expect(
    screen.getByRole('button', { name: /下一条回复|Next reply/ })
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: /上一条回复|Previous reply/ })
  ).toBeEnabled();
});

it('offers neither action on a conversation that is only an opening line', async () => {
  const recorded: Recorded = { generations: [], activated: [] };
  mockCloud(recorded);

  render(<App />);
  await screen.findByText('你也来看星星吗？', { selector: '.message-bubble' });

  // The opening line answers nothing, so there is no message to answer again — and
  // Cloud would refuse it with WRONG_STATE. A button that can only fail is not offered.
  expect(
    screen.queryByRole('button', { name: /重新生成|Regenerate reply/ })
  ).not.toBeInTheDocument();
});
