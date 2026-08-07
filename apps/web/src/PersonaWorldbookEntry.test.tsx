import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetLoreDatabaseForTests } from './lib/lore-store';
import {
  bindConversationPersona,
  createPersona
} from './lib/persona';
import { createWorldbook } from './lib/worldbook';

/**
 * Entry-point coverage: the two features have to be reachable from the shell the user
 * actually sees, and Persona/worldbook content must come from the browser-local source
 * of truth rather than the legacy Cloud asset endpoints.
 */

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const CHARACTER = {
  character_id: 'firefly-card',
  name: '流萤',
  profile_summary: '星核猎手成员',
  personality_summary: '温柔而坚定',
  first_message: '要一起出发吗？',
  avatar_seed: '流萤',
  is_owned: true,
  last_message: null
};

function mockShell(handler: (path: string, init?: RequestInit) => Promise<Response> | null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    const custom = handler(path, init ?? undefined);
    if (custom) return custom;
    if (path === '/v1/cloud/status') {
      return json({
        cloud: {
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
        }
      });
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
    if (path === '/v1/identities/anonymous') {
      return json({
        user: {
          user_id: 'user-1',
          anonymous_id: 'anonymous-1',
          identity_type: 'EMAIL',
          email: 'a@example.com',
          registered: true
        }
      });
    }
    if (path === '/v1/characters') return json({ characters: [CHARACTER] });
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations/conversation-1/messages') {
      return json({
        messages: [
          {
            message_id: 'message-1',
            role: 'ASSISTANT',
            content_text: '要一起出发吗？',
            status: 'COMPLETED'
          }
        ]
      });
    }
    if (path === '/v1/conversations/conversation-1/reply-suggestions') {
      return json({ suggestions: [] });
    }
    return json({ error: { code: 'NOT_FOUND', message: `unexpected ${path}` } }, 404);
  });
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

describe('persona and worldbook entry points', () => {
  it('opens persona management from the settings panel', async () => {
    await createPersona({
      name: '林岸',
      description: '一名夜班记者。'
    });
    mockShell((path) => {
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /用户身份/ }));

    expect(await screen.findByRole('dialog', { name: '用户身份' })).toBeInTheDocument();
    expect(await screen.findByText('林岸')).toBeInTheDocument();
  });

  it('opens worldbook management from the settings panel', async () => {
    await createWorldbook('白港设定集');
    mockShell((path) => {
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /世界书/ }));

    expect(await screen.findByRole('dialog', { name: '世界书' })).toBeInTheDocument();
    expect(await screen.findByText('白港设定集')).toBeInTheDocument();
  });

  it('opens the conversation persona picker preselected with the bound persona', async () => {
    const firstPersona = await createPersona({
      name: '林岸',
      description: '夜班记者。'
    });
    await createPersona({
      name: '沈迟',
      description: '外科医生。'
    });
    await bindConversationPersona('conversation-1', firstPersona.persona_id);
    mockShell((path) => {
      if (path === '/v1/conversations') {
        return json({ conversation_id: 'conversation-1' }, 201);
      }
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));
    fireEvent.click(await screen.findByRole('button', { name: '本次对话的身份' }));

    const dialog = await screen.findByRole('dialog', { name: '本次对话的身份' });
    await waitFor(() => expect(dialog).toHaveTextContent('林岸'));
    // Preselection comes from the conversation's durable local binding.
    const selected = dialog.querySelector('.persona-item.selected');
    expect(selected?.textContent).toContain('林岸');
  });

  it('opens the character worldbook picker from the character profile', async () => {
    await createWorldbook('白港设定集');
    mockShell((path) => {
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));
    fireEvent.click(await screen.findByRole('button', { name: '关联世界书' }));

    expect(await screen.findByRole('dialog', { name: '流萤的世界书' })).toBeInTheDocument();
    expect(await screen.findByText('白港设定集')).toBeInTheDocument();
  });

  it('keeps chatting when the service reports no persona for a conversation', async () => {
    mockShell((path) => {
      // A deployment without the persona API answers the conversation call as before.
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      return null;
    });

    render(<App />);

    // The opening line shows both in the contact rail and in the transcript.
    expect((await screen.findAllByText('要一起出发吗？')).length).toBeGreaterThan(0);
  });
});
