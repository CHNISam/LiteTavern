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

function installChatFetch(
  suggestions: string[] = [],
  options: { failFirstSuggestion?: boolean; conflictFirstSuggestion?: boolean } = {}
) {
  const requested: string[] = [];
  const suggestionKeys: string[] = [];
  let suggestionCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    requested.push(path);
    if (path === '/v1/cloud/status') return json({ cloud: {
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
      is_owned: true, last_message: 'Ready when you are.'
    }] });
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [{
      message_id: 'message-1', role: 'ASSISTANT',
      content_text: 'Ready when you are.', status: 'COMPLETED'
    }] });
    if (path === '/v1/conversations/conversation-1/reply-suggestions') {
      suggestionCalls += 1;
      suggestionKeys.push(
        String(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      );
      // Cloud remembers a failed request under its key and answers a replay of it
      // with 409 — the shape that makes a naive retry permanently unserviceable.
      // A key Cloud has already closed. This is what a reader meets after a
      // reload, when the in-memory attempt counter is back at zero.
      if (options.conflictFirstSuggestion && suggestionCalls === 1) {
        return json(
          {
            error: {
              code: 'EMPTY_RESPONSE',
              message: '这次请求此前已失败，请重新发起。',
              retryable: true
            }
          },
          409
        );
      }
      if (options.failFirstSuggestion && suggestionCalls === 1) {
        return json(
          {
            error: {
              code: 'PROVIDER_UNAVAILABLE',
              message: '模型调用失败，未消耗额度。',
              retryable: true
            }
          },
          502
        );
      }
      return json({ suggestions });
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
  return Object.assign(requested, { suggestionKeys });
}

/**
 * Press 代写 once it is actually pressable.
 *
 * The button is disabled until the transcript has loaded — there is nothing to suggest
 * a reply to before then — so clicking the moment the composer appears is a no-op that
 * looks like a broken feature.
 */
async function pressWriteAsMe() {
  const button = await screen.findByRole('button', { name: /Write as me|代写/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

it('fills the composer from a configured local quick reply without sending it', async () => {
  localStorage.setItem('litetavern.quick-replies.v1', JSON.stringify({
    enabled: true,
    behavior: 'FILL',
    replies: [{
      id: 'mission', label: 'Ask about the mission',
      message: 'What is our mission?', enabled: true
    }]
  }));
  const requested = installChatFetch();

  render(<App />);
  const composer = await screen.findByPlaceholderText(/Nova/);
  fireEvent.click(screen.getByRole('button', { name: 'Ask about the mission' }));

  expect(composer).toHaveValue('What is our mission?');
  expect(requested.some((path) => path.endsWith('/generations'))).toBe(false);
});

it('offers user-side candidates on demand and sends the one the reader picks', async () => {
  const requested = installChatFetch([
    'I will go with you.',
    'Give me a moment.',
    'Not tonight.'
  ]);

  render(<App />);
  const composer = await screen.findByPlaceholderText(/Nova/);
  await pressWriteAsMe();

  // All three are offered. The reader chooses; the button does not choose for them.
  await screen.findByRole('button', { name: 'Give me a moment.' });
  expect(screen.getByRole('button', { name: 'Not tonight.' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Give me a moment.' }));

  // Picking is the decision, so it goes. The candidate never waits in the
  // composer for a send press the reader has effectively already made.
  await waitFor(() =>
    expect(requested.some((path) => path.endsWith('/generations'))).toBe(true)
  );
  expect(composer).toHaveValue('');
});

it('asks for suggestions once and reuses them while the story has not moved', async () => {
  // Cloud replays a settled idempotency key without charging, and this skips even
  // that round trip: pressing 代写 twice on the same head must not cost twice.
  const requested = installChatFetch(['I will go with you.']);

  render(<App />);
  await screen.findByPlaceholderText(/Nova/);
  await pressWriteAsMe();
  await screen.findByRole('button', { name: 'I will go with you.' });
  await pressWriteAsMe();

  await waitFor(() => expect(
    requested.filter((path) => path.endsWith('/reply-suggestions'))
  ).toHaveLength(1));
});

it('reports an empty result rather than leaving the button looking stuck', async () => {
  const requested = installChatFetch([]);

  render(<App />);
  await screen.findByPlaceholderText(/Nova/);
  await pressWriteAsMe();

  await waitFor(() => expect(
    requested.some((path) => path.endsWith('/reply-suggestions'))
  ).toBe(true));
  await screen.findByText(/暂时没有可用的用户视角回复|No user-perspective reply/);
});

it('sends a configured quick reply only when direct-send behavior is enabled', async () => {
  localStorage.setItem('litetavern.quick-replies.v1', JSON.stringify({
    enabled: true,
    behavior: 'SEND',
    replies: [{
      id: 'depart', label: 'Depart now', message: 'Let us go.', enabled: true
    }]
  }));
  const requested = installChatFetch();

  render(<App />);
  await screen.findByPlaceholderText(/Nova/);
  fireEvent.click(screen.getByRole('button', { name: 'Depart now' }));

  await waitFor(() => expect(
    requested.some((path) => path.endsWith('/generations'))
  ).toBe(true));
  expect(screen.getByText('Let us go.', { selector: '.message-bubble' }))
    .toBeInTheDocument();
});

it('retries under a fresh key so one failure cannot disable 代写 for good', async () => {
  // The key is derived from the conversation head so that a repeat press replays
  // instead of paying twice. That same determinism is what would make a stored
  // failure permanent: without a per-attempt component, "try again" rebuilds the
  // rejected key and Cloud answers 409 forever — until the reader happens to send
  // another message. A transient upstream error must degrade the attempt, not the
  // conversation.
  const requested = installChatFetch(['I will go with you.'], {
    failFirstSuggestion: true
  });

  render(<App />);
  await screen.findByPlaceholderText(/Nova/);

  await pressWriteAsMe();
  await screen.findByText(/模型调用失败/);

  await pressWriteAsMe();
  await screen.findByRole('button', { name: 'I will go with you.' });

  const keys = requested.suggestionKeys;
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  // Still anchored to the same conversation state, so a later press replays the
  // successful set rather than buying a third.
  expect(keys[1]).toContain(String(keys[0]));
});

it('steps past a key Cloud has already closed, without the reader retrying', async () => {
  // The attempt counter lives in memory, so a reload puts the reader back on the
  // rejected key. If a stored failure could only be escaped by pressing again, the
  // feature would look broken on exactly the visit where it mattered.
  const requested = installChatFetch(['I will go with you.'], {
    conflictFirstSuggestion: true
  });

  render(<App />);
  await screen.findByPlaceholderText(/Nova/);
  await pressWriteAsMe();

  // One press, two requests, candidates on screen and no error shown.
  await screen.findByRole('button', { name: 'I will go with you.' });
  expect(requested.suggestionKeys).toHaveLength(2);
  expect(requested.suggestionKeys[0]).not.toBe(requested.suggestionKeys[1]);
  expect(screen.queryByText(/此前已失败/)).not.toBeInTheDocument();
});
