import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetLoreDatabaseForTests } from './lib/lore-store';
import {
  RegexPlacement,
  saveCharacterRegexBundle
} from './lib/regex-engine';

/**
 * Suggestions are part of the same structured model response as the assistant
 * bubbles. The new client never calls the legacy reply-suggestions route.
 */

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function character(id: string, name: string) {
  return {
    character_id: id,
    name,
    profile_summary: '星核猎手成员',
    personality_summary: '温柔而坚定',
    first_message: '又见面了。',
    avatar_seed: name,
    is_owned: true,
    last_message: null
  };
}

interface ShellOptions {
  characters?: ReturnType<typeof character>[];
  /** Suggestions returned inline by the turn endpoint. */
  turnSuggestions?: string[];
  turnMessages?: string[];
  messages?: Record<string, unknown>[];
  messagesByConversation?: Record<string, Record<string, unknown>[]>;
  messageDelayMs?: Record<string, number>;
}

function mockShell({
  characters = [character('firefly-card', '流萤')],
  turnSuggestions,
  turnMessages = ['收到。'],
  messages = [],
  messagesByConversation,
  messageDelayMs
}: ShellOptions = {}) {
  const requested: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const headers = new Headers(init?.headers);
    requested.push({
      path,
      method: init?.method ?? 'GET',
      ...(rawBody
        ? { body: JSON.parse(rawBody) as Record<string, unknown> }
        : {}),
      ...(headers.get('Idempotency-Key')
        ? { idempotencyKey: headers.get('Idempotency-Key')! }
        : {})
    });
    if (path === '/v1/cloud/status') {
      return json({
        cloud: {
          stage: 'ALPHA',
          platform_models_available: true,
          model_service: { available: true, reason_code: null },
          identity_type: 'ANONYMOUS',
          registered: false,
          membership_status: 'ANONYMOUS_TRIAL',
          on_waitlist: false,
          waitlist_joined_at: null,
          alpha_active: false,
          alpha_granted: false,
          alpha_granted_at: null,
          alpha_activated_at: null,
          alpha_batch_id: null,
          alpha_grant_source: null,
          alpha_status_reason: null,
          founding_supporter: false,
          quota: {
            source: 'TRIAL',
            total: 30,
            used: 0,
            reserved: 0,
            available: 30,
            remaining_ratio: 1,
            cycle_no: null,
            cycle_starts_at: null,
            cycle_ends_at: null
          },
          support: { enabled: false, url: '', headline: '', body: '' },
          next_actions: ['START_CHATTING', 'REGISTER']
        }
      });
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/identities/anonymous') {
      return json({
        user: {
          user_id: 'user-1',
          anonymous_id: 'anonymous-1',
          identity_type: 'ANONYMOUS',
          free_quota_total: 30,
          free_quota_remaining: 30,
          free_quota_available: 30,
          free_quota_enabled: true
        }
      });
    }
    if (path === '/v1/analytics/events') return json({ accepted: 1 }, 202);
    if (path === '/v1/characters') return json({ characters });
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') {
      const body = JSON.parse(String(init?.body)) as { character_id: string };
      return json({ conversation_id: `conversation-${body.character_id}` }, 201);
    }
    if (path.endsWith('/messages')) {
      const selected = messagesByConversation?.[path] ?? messages;
      const delay = messageDelayMs?.[path] ?? 0;
      return delay > 0
        ? new Promise((resolve) => setTimeout(
            () => resolve(new Response(JSON.stringify({ messages: selected }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })),
            delay
          ))
        : json({ messages: selected });
    }
    if (path.endsWith('/reply-suggestions')) return json({ suggestions: ['稍后再说'] });
    if (path.endsWith('/turns')) {
      return json(
        {
          turn_id: 'turn-1',
          messages: turnMessages,
          ...(turnSuggestions ? { suggestions: turnSuggestions } : {})
        },
        201
      );
    }
    if (path.endsWith('/bubbles')) return json({ saved: true }, 201);
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
  return requested;
}

/** Requests that cost a model call. */
function suggestionCalls(requested: { path: string }[]) {
  return requested.filter((entry) => entry.path.endsWith('/reply-suggestions'));
}

/** Lets any debounced follow-up work fire before an absence is asserted. */
async function settle(ms = 700) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

describe('request economy', () => {
  /**
   * Sends one message and waits for the reply bubble to actually land. The turn's
   * `onDone` follow-up only fires after playback, so asserting before this point
   * would pass for the wrong reason.
   */
  async function sendAndPlayOut() {
    const composer = await screen.findByPlaceholderText('给流萤发送短信…');
    fireEvent.change(composer, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await screen.findByText('收到。', { selector: '.message-bubble' }, { timeout: 8000 });
    await settle();
  }

  it('spends one model call per turn when the turn already returned suggestions', async () => {
    const requested = mockShell({ turnSuggestions: ['那就出发吧', '再等等'] });
    render(<App />);

    await sendAndPlayOut();

    // The turn carried its own suggestions, so nothing may ask the model again.
    expect(suggestionCalls(requested)).toHaveLength(0);
    expect(screen.getByRole('button', { name: '那就出发吧' })).toBeInTheDocument();
    const turn = requested.find((entry) => entry.path.endsWith('/turns'));
    expect(turn?.body).toMatchObject({
      input: { type: 'text', text: '你好' },
      client_context: {
        version: 1,
        activation_seed: turn?.idempotencyKey,
        worldbook_entries: []
      }
    });
    const suggestion = screen.getByRole('button', { name: '那就出发吧' });
    fireEvent.click(suggestion);
    const composer = screen.getByPlaceholderText('给流萤发送短信…');
    await waitFor(() => expect(composer).toHaveValue('那就出发吧'));
    await waitFor(() => expect(document.activeElement).toBe(composer));
    fireEvent.change(composer, { target: { value: '那就出发吧！' } });
    expect(
      screen.queryByRole('button', { name: '再等等' })
    ).not.toBeInTheDocument();
  }, 15000);

  it('does not make a supplemental call when the turn returns no suggestions', async () => {
    const requested = mockShell();
    render(<App />);

    await sendAndPlayOut();

    expect(suggestionCalls(requested)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: '稍后再说' })).not.toBeInTheDocument();
  }, 15000);

  it('runs USER_INPUT and AI_OUTPUT Regex exactly once per sent turn', async () => {
    await saveCharacterRegexBundle(
      'firefly-card',
      [
        {
          id: 'input-once',
          scriptName: '输入一次',
          findRegex: '/a/g',
          replaceString: 'aa',
          placement: [RegexPlacement.USER_INPUT]
        },
        {
          id: 'output-once',
          scriptName: '输出一次',
          findRegex: '/x/g',
          replaceString: 'xx',
          placement: [RegexPlacement.AI_OUTPUT]
        }
      ],
      true
    );
    const requested = mockShell({ turnMessages: ['x'] });
    render(<App />);

    const composer = await screen.findByPlaceholderText('给流萤发送短信…');
    fireEvent.change(composer, { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    await screen.findByText('xx', { selector: '.message-bubble' }, {
      timeout: 8000
    });
    const turn = requested.find((entry) => entry.path.endsWith('/turns'));
    expect(turn?.body).toMatchObject({
      input: { type: 'text', text: 'aa' }
    });
    expect(
      screen.queryByText('xxxx', { selector: '.message-bubble' })
    ).not.toBeInTheDocument();
  }, 15000);

  it('costs nothing to click the contact that is already open', async () => {
    const requested = mockShell({
      messages: [
        { message_id: 'm-1', role: 'ASSISTANT', content_text: '又见面了。', status: 'COMPLETED' }
      ]
    });
    render(<App />);

    await screen.findByPlaceholderText('给流萤发送短信…');
    await settle();
    const before = requested.length;

    const rail = screen.getByRole('complementary');
    const contact = within(rail).getByRole('button', { name: /流萤/ });
    fireEvent.click(contact);
    fireEvent.click(contact);
    fireEvent.click(contact);
    await settle();

    expect(requested.slice(before)).toEqual([]);
  });

  it('does not request suggestions while switching conversations', async () => {
    const requested = mockShell({
      characters: [character('firefly-card', '流萤'), character('march-card', '三月七')],
      messages: [
        { message_id: 'm-1', role: 'ASSISTANT', content_text: '又见面了。', status: 'COMPLETED' }
      ]
    });
    render(<App />);

    const rail = await screen.findByRole('complementary');
    await settle();
    const before = suggestionCalls(requested).length;

    // A restless switch back and forth must not bill one model call per click.
    fireEvent.click(within(rail).getByRole('button', { name: /三月七/ }));
    fireEvent.click(within(rail).getByRole('button', { name: /流萤/ }));
    fireEvent.click(within(rail).getByRole('button', { name: /三月七/ }));
    await settle();

    const spent = suggestionCalls(requested).slice(before);
    expect(spent).toHaveLength(0);
  });

  it('clears the previous character messages while the next conversation loads', async () => {
    mockShell({
      characters: [character('alpha-card', 'Alpha'), character('beta-card', 'Beta')],
      messagesByConversation: {
        '/v1/conversations/conversation-alpha-card/messages': [
          { message_id: 'alpha-1', role: 'ASSISTANT', content_text: 'alpha-private', status: 'COMPLETED' }
        ],
        '/v1/conversations/conversation-beta-card/messages': [
          { message_id: 'beta-1', role: 'ASSISTANT', content_text: 'beta-private', status: 'COMPLETED' }
        ]
      },
      messageDelayMs: {
        '/v1/conversations/conversation-beta-card/messages': 250
      }
    });
    render(<App />);

    expect(await screen.findByText('alpha-private', { selector: '.message-bubble' })).toBeInTheDocument();
    const rail = await screen.findByRole('complementary');
    fireEvent.click(within(rail).getByRole('button', { name: /Beta/ }));
    expect(screen.getByPlaceholderText(/Beta/)).toBeInTheDocument();
    expect(screen.queryByText('alpha-private', { selector: '.message-bubble' })).not.toBeInTheDocument();
    expect(await screen.findByText('beta-private', { selector: '.message-bubble' })).toBeInTheDocument();
  });

  it('keeps the settled conversation even when an earlier open resolves last', async () => {
    const requested = mockShell({
      characters: [character('firefly-card', '流萤'), character('march-card', '三月七')]
    });
    render(<App />);

    const rail = await screen.findByRole('complementary');
    fireEvent.click(
      await within(rail).findByRole('button', { name: /三月七/ })
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText('给三月七发送短信…')).toBeInTheDocument()
    );
    await settle();

    // No stale open may reinstate the previous character's composer.
    expect(screen.getByPlaceholderText('给三月七发送短信…')).toBeInTheDocument();
    expect(requested.some((entry) => entry.path.endsWith('/turns'))).toBe(false);
  });
});
