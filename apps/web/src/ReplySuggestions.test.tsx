/**
 * The automatic reply-suggestions trigger, over the streaming route real deployments use.
 *
 * The rules worth protecting here are the ones that make this an *optional* helper:
 *
 *  - turning it on must not change the generation request in any way, so the character
 *    says what it would have said either way;
 *  - it fires only after the reply has landed, never alongside it;
 *  - turning it off means no suggestion request at all, not a hidden one;
 *  - and when it fails, the reply the reader already has stays exactly as it was.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetLoreDatabaseForTests } from './lib/lore-store';
import { REPLY_SUGGESTIONS_STORAGE_KEY } from './lib/reply-suggestions';

interface Recorded {
  path: string;
  body: unknown;
}

function readBody(init: RequestInit | undefined): unknown {
  try {
    return init?.body ? JSON.parse(String(init.body)) : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

const REPLY = '我在的，刚下手术。';

function mockShell(options: { suggestions?: string[]; suggestionStatus?: number } = {}) {
  const requested: Recorded[] = [];
  const encoder = new TextEncoder();
  let replied = false;

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    requested.push({ path, body: readBody(init) });

    if (path === '/v1/cloud/status') {
      return json({ cloud: {
        stage: 'ALPHA',
        contract_version: 2,
        capabilities: { auth: true, asset_sync: true, platform_generation: true, client_turn_sync: true, reply_suggestions: true },
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
    if (path === '/v1/identities/anonymous') return json({ user: {
      user_id: 'user-1', anonymous_id: 'anonymous-1', identity_type: 'ANONYMOUS',
      email: null, registered: false
    } });
    if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
    if (path === '/v1/characters') return json({ characters: [{
      character_id: 'nova-card', name: 'Nova', profile_summary: 'Pilot',
      personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova',
      is_owned: true, last_message: '在吗？'
    }] });
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') {
      // Before the turn: the opening line. After it: the persisted assistant reply,
      // which is what the client aligns its optimistic bubble against.
      return json({ messages: replied
        ? [
            { message_id: 'message-1', role: 'ASSISTANT', content_text: '在吗？', status: 'COMPLETED' },
            { message_id: 'message-2', role: 'USER', content_text: '你还在医院吗？', status: 'COMPLETED' },
            { message_id: 'message-3', role: 'ASSISTANT', content_text: REPLY, status: 'COMPLETED' }
          ]
        : [
            { message_id: 'message-1', role: 'ASSISTANT', content_text: '在吗？', status: 'COMPLETED' }
          ] });
    }
    if (path === '/v1/conversations/conversation-1/generations') {
      replied = true;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: start\ndata: {"generation_request_id":"generation-1"}\n\n' +
            `event: delta\ndata: ${JSON.stringify({ text: REPLY })}\n\n` +
            'event: done\ndata: {"generation_request_id":"generation-1","message_id":"message-3"}\n\n'
          ));
          controller.close();
        }
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
    }
    if (path === '/v1/conversations/conversation-1/reply-suggestions') {
      if (options.suggestionStatus) {
        return json(
          { error: { code: 'PROVIDER_UNAVAILABLE', message: '模型调用失败。', retryable: true } },
          options.suggestionStatus
        );
      }
      return json({ suggestions: options.suggestions ?? ['那你先休息。', '要我过去吗？'] });
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
  return requested;
}

function useAutomatic() {
  localStorage.setItem(
    REPLY_SUGGESTIONS_STORAGE_KEY,
    JSON.stringify({ trigger: 'AUTOMATIC' })
  );
}

async function sendOnce() {
  const composer = await screen.findByPlaceholderText(/Nova/);
  fireEvent.change(composer, { target: { value: '你还在医院吗？' } });
  await waitFor(() => expect(
    screen.getByRole('button', { name: /发送消息|Send message/ })
  ).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /发送消息|Send message/ }));
  await screen.findByText(REPLY, { selector: '.message-bubble' });
}

/** Lets a fire-and-forget follow-up either happen or provably not happen. */
async function settle(ms = 400) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A generation request with its per-request nonces removed.
 *
 * The message id, the activation seed and the turn timestamp differ between any two
 * sends and are supposed to. Everything else is what the character is being asked, and
 * that is what must not depend on a suggestions setting.
 */
function stableGenerationBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.client_message_id;
  const context = rest.client_context;
  if (context && typeof context === 'object') {
    const contextRest = { ...(context as Record<string, unknown>) };
    delete contextRest.activation_seed;
    delete contextRest.turn_time;
    rest.client_context = contextRest;
  }
  return rest;
}

function suggestionCalls(requested: Recorded[]) {
  return requested.filter((entry) => entry.path.endsWith('/reply-suggestions'));
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

it('asks for suggestions after the reply lands, and shows them', async () => {
  useAutomatic();
  const requested = mockShell();

  render(<App />);
  await sendOnce();

  await screen.findByRole('button', { name: '那你先休息。' });
  expect(screen.getByRole('button', { name: '要我过去吗？' })).toBeInTheDocument();

  const calls = suggestionCalls(requested);
  expect(calls).toHaveLength(1);
  // Ordered: the generation is requested first and the suggestions only after it.
  const order = requested.map((entry) => entry.path);
  expect(order.indexOf('/v1/conversations/conversation-1/generations'))
    .toBeLessThan(order.indexOf('/v1/conversations/conversation-1/reply-suggestions'));

});

// Picking a candidate *is* the decision. Parking it in the composer asked the
// reader to confirm a choice they had already made, putting the send button in
// front of a message they had already chosen.
it('sends the candidate the reader picks instead of parking it in the composer', async () => {
  useAutomatic();
  const requested = mockShell();

  render(<App />);
  await sendOnce();

  await screen.findByRole('button', { name: '要我过去吗？' });
  const before = requested.filter((entry) => entry.path.endsWith('/generations')).length;

  fireEvent.click(screen.getByRole('button', { name: '要我过去吗？' }));

  await waitFor(() => {
    const sends = requested.filter((entry) => entry.path.endsWith('/generations'));
    expect(sends).toHaveLength(before + 1);
    expect(
      (sends.at(-1)?.body as { input?: { text?: string } } | undefined)?.input?.text
    ).toBe('要我过去吗？');
  });
  expect(screen.getByPlaceholderText(/Nova/)).toHaveValue('');
  // The send this test just made has its own automatic follow-up. Letting it
  // finish here keeps it from landing in the next test's recorded calls.
  await settle();
});

// Typing removes the chips, so the "reader has their own draft" guard in the
// handler is a belt-and-braces check rather than a reachable state. The rule it
// protects — a candidate never overwrites the reader's own words — is covered by
// the composer being empty above.

it('does not request suggestions at all when the trigger is manual', async () => {
  const requested = mockShell();

  render(<App />);
  await sendOnce();
  await settle();

  // The default. A reader who never opts in never pays for an extra inference.
  expect(suggestionCalls(requested)).toHaveLength(0);
  expect(screen.queryByRole('button', { name: '那你先休息。' })).not.toBeInTheDocument();
});

it('sends the same generation request whether or not automatic is on', async () => {
  // The whole reason suggestions are a separate call: switching this on must not
  // change what the character is asked to say.
  const manual = mockShell();
  render(<App />);
  await sendOnce();
  await settle();
  const manualGeneration = manual.find((entry) => entry.path.endsWith('/generations'));

  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();

  useAutomatic();
  const automatic = mockShell();
  render(<App />);
  await sendOnce();
  await screen.findByRole('button', { name: '那你先休息。' });
  const automaticGeneration = automatic.find((entry) => entry.path.endsWith('/generations'));

  expect(stableGenerationBody(automaticGeneration?.body))
    .toEqual(stableGenerationBody(manualGeneration?.body));
});

it('keeps the reply when the suggestion request fails', async () => {
  useAutomatic();
  const requested = mockShell({ suggestionStatus: 503 });

  render(<App />);
  await sendOnce();
  await settle();

  // The helper failed after the reader already had their reply. It must not turn a
  // delivered turn into a visible failure, and it must not remove the reply.
  expect(suggestionCalls(requested)).toHaveLength(1);
  expect(screen.getByText(REPLY, { selector: '.message-bubble' })).toBeInTheDocument();
  expect(screen.queryByText(/模型调用失败/)).not.toBeInTheDocument();
});

it('produces nothing to show when the model returns no candidates', async () => {
  useAutomatic();
  const requested = mockShell({ suggestions: [] });

  render(<App />);
  await sendOnce();
  await settle();

  expect(suggestionCalls(requested)).toHaveLength(1);
  expect(screen.getByText(REPLY, { selector: '.message-bubble' })).toBeInTheDocument();
  // An empty set is silent under the automatic trigger: nobody asked.
  expect(screen.queryByText(/暂时没有可用的用户视角回复/)).not.toBeInTheDocument();
});
