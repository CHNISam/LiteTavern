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

function installChatFetch(suggestions: string[] = []) {
  const requested: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
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
      return json({ suggestions });
    }
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
  return requested;
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

it('offers user-side candidates on demand and fills the composer from one', async () => {
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
  await waitFor(() => expect(composer).toHaveValue('Give me a moment.'));

  // Picking a candidate is not sending it, and nothing was written to the transcript.
  expect(screen.queryByText('Give me a moment.', { selector: '.message-bubble' }))
    .not.toBeInTheDocument();
  expect(requested.some((path) => path.endsWith('/generations'))).toBe(false);
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
