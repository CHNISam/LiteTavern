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
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/identities/anonymous') return json({ user: {
      user_id: 'user-1', anonymous_id: 'anonymous-1', identity_type: 'ANONYMOUS',
      free_quota_remaining: 30, free_quota_enabled: true
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

it('impersonates the user into the composer without persisting or sending', async () => {
  const requested = installChatFetch(['I will go with you.']);

  render(<App />);
  const composer = await screen.findByPlaceholderText(/Nova/);
  fireEvent.click(screen.getByRole('button', { name: /Write as me|代写/ }));

  await waitFor(() => expect(composer).toHaveValue('I will go with you.'));
  expect(screen.queryByText('I will go with you.', { selector: '.message-bubble' }))
    .not.toBeInTheDocument();
  expect(requested.some((path) => path.endsWith('/generations'))).toBe(false);
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
