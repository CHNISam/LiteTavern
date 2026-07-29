import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * Entry-point coverage: the two features have to be reachable from the shell the user
 * actually sees, and the identity a conversation is opened with has to come from the
 * server rather than from whatever the client last had in memory.
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
          platform_models_available: true,
          identity_type: 'ANONYMOUS',
          registered: false,
          quota: {
            source: 'TRIAL',
            total: 30,
            used: 0,
            reserved: 0,
            available: 30,
            remaining_ratio: 1,
            cycle_ends_at: null
          },
          support: { enabled: false },
          next_actions: ['START_CHATTING']
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
          identity_type: 'ANONYMOUS',
          free_quota_remaining: 30,
          free_quota_enabled: true
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('persona and worldbook entry points', () => {
  it('opens persona management from the settings panel', async () => {
    mockShell((path) => {
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/personas') {
        return json({
          personas: [
            {
              persona_id: 'persona-1',
              name: '林岸',
              description: '一名夜班记者。',
              is_default: true
            }
          ]
        });
      }
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /用户身份/ }));

    expect(await screen.findByRole('dialog', { name: '用户身份' })).toBeInTheDocument();
    expect(await screen.findByText('林岸')).toBeInTheDocument();
  });

  it('opens worldbook management from the settings panel', async () => {
    mockShell((path) => {
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/worldbooks') {
        return json({
          worldbooks: [
            {
              worldbook_id: 'book-1',
              name: '白港设定集',
              description: '',
              enabled: true,
              scan_depth: null,
              token_budget: null,
              origin: 'USER',
              entry_count: 3
            }
          ]
        });
      }
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /世界书/ }));

    expect(await screen.findByRole('dialog', { name: '世界书' })).toBeInTheDocument();
    expect(await screen.findByText('白港设定集')).toBeInTheDocument();
  });

  it('opens the conversation persona picker preselected with the bound persona', async () => {
    mockShell((path) => {
      if (path === '/v1/conversations') {
        // The server binds the default persona when the conversation is created.
        return json({ conversation_id: 'conversation-1', persona_id: 'persona-1' }, 201);
      }
      if (path === '/v1/personas') {
        return json({
          personas: [
            { persona_id: 'persona-1', name: '林岸', description: '夜班记者。', is_default: true },
            { persona_id: 'persona-2', name: '沈迟', description: '外科医生。', is_default: false }
          ]
        });
      }
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));
    fireEvent.click(await screen.findByRole('button', { name: '角色设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /本次对话的身份/ }));

    const dialog = await screen.findByRole('dialog', { name: '本次对话的身份' });
    await waitFor(() => expect(dialog).toHaveTextContent('林岸'));
    // Preselection comes from what the server reported, not from a client guess.
    const selected = dialog.querySelector('.persona-item.selected');
    expect(selected?.textContent).toContain('林岸');
  });

  it('opens the character worldbook picker from character settings', async () => {
    mockShell((path) => {
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/worldbooks') {
        return json({
          worldbooks: [
            {
              worldbook_id: 'book-1',
              name: '白港设定集',
              description: '',
              enabled: true,
              scan_depth: null,
              token_budget: null,
              origin: 'USER',
              entry_count: 3
            }
          ]
        });
      }
      if (path === '/v1/characters/firefly-card/worldbooks') return json({ worldbooks: [] });
      return null;
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));
    fireEvent.click(await screen.findByRole('button', { name: '角色设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /关联世界书/ }));

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
