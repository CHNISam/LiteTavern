import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * Every reply-suggestion request is a paid model call. These tests pin the rules
 * that keep a restless clicker from draining an allowance they cannot see:
 * one turn never costs two model calls, re-selecting the open contact costs
 * nothing, and only the conversation the reader settles on is ever suggested for.
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
  messages?: Record<string, unknown>[];
}

function mockShell({
  characters = [character('firefly-card', '流萤')],
  turnSuggestions,
  messages = []
}: ShellOptions = {}) {
  const requested: { path: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    requested.push({ path, method: init?.method ?? 'GET' });
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
    if (path.endsWith('/messages')) return json({ messages });
    if (path.endsWith('/reply-suggestions')) return json({ suggestions: ['稍后再说'] });
    if (path.endsWith('/turns')) {
      return json(
        {
          turn_id: 'turn-1',
          messages: ['收到。'],
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
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
  }, 15000);

  it('asks for suggestions once when the turn did not return any', async () => {
    const requested = mockShell();
    render(<App />);

    await sendAndPlayOut();

    expect(suggestionCalls(requested)).toHaveLength(1);
    expect(await screen.findByRole('button', { name: '稍后再说' })).toBeInTheDocument();
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

  it('only suggests for the conversation the reader settles on', async () => {
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
    expect(spent).toHaveLength(1);
    expect(spent[0]!.path).toBe('/v1/conversations/conversation-march-card/reply-suggestions');
  });

  it('keeps the settled conversation even when an earlier open resolves last', async () => {
    const requested = mockShell({
      characters: [character('firefly-card', '流萤'), character('march-card', '三月七')]
    });
    render(<App />);

    const rail = await screen.findByRole('complementary');
    fireEvent.click(within(rail).getByRole('button', { name: /三月七/ }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText('给三月七发送短信…')).toBeInTheDocument()
    );
    await settle();

    // No stale open may reinstate the previous character's composer.
    expect(screen.getByPlaceholderText('给三月七发送短信…')).toBeInTheDocument();
    expect(requested.some((entry) => entry.path.endsWith('/turns'))).toBe(false);
  });
});
