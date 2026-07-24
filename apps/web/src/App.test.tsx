import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HSR message shell', () => {
  it('starts empty and asks for a Firefly character card instead of inventing characters', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: '导入流萤角色卡' })).toBeInTheDocument();
    expect(screen.queryByText('林雾')).not.toBeInTheDocument();
    expect(screen.queryByText('祁安')).not.toBeInTheDocument();
    expect(screen.queryByText('阿澄')).not.toBeInTheDocument();
  });

  it('uses the imported card PNG as the avatar and follows chat → profile → settings', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    const avatar = await screen.findByRole('img', { name: '流萤头像' });
    expect(avatar).toHaveAttribute('src', '/v1/characters/firefly-card/avatar');
    fireEvent.click(screen.getByRole('button', { name: '打开流萤档案' }));
    expect(await screen.findByRole('heading', { name: '流萤' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^角色设置/ }));
    await waitFor(() => {
      expect(screen.getByText('角色设置', { selector: '.detail-title' })).toBeInTheDocument();
    });
    expect(screen.getAllByText('导入角色卡').length).toBeGreaterThan(0);
    expect(screen.getByText('模型选择')).toBeInTheDocument();
  });

  it('copies a sent message and edits it into a new multi-bubble turn', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [
        { message_id: 'm-1', role: 'ASSISTANT', content_text: '又见面了。', status: 'COMPLETED' },
        { message_id: 'm-2', role: 'USER', content_text: '你认为呢', status: 'COMPLETED' },
        { message_id: 'm-3', role: 'ASSISTANT', content_text: '我认为该出发了。', status: 'COMPLETED' }
      ] });
      if (path === '/v1/conversations/conversation-1/reply-suggestions') return json({ suggestions: [] });
      if (path === '/v1/conversations/conversation-1/turns') {
        turns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ turn_id: 'turn-1', messages: ['那就走吧。'] }, 201);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(await screen.findByText('你认为呢')).toBeInTheDocument();
    // Both user and character bubbles now expose a copy button; scope to each one.
    const userBubble = screen.getByText('你认为呢').closest('.hsr-message') as HTMLElement;
    fireEvent.click(within(userBubble).getByRole('button', { name: '复制消息' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('你认为呢'));

    const charBubble = screen.getByText('我认为该出发了。', { selector: '.message-bubble' }).closest('.hsr-message') as HTMLElement;
    fireEvent.click(within(charBubble).getByRole('button', { name: '复制消息' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('我认为该出发了。'));
    // The character bubble offers copy only, never edit.
    expect(within(charBubble).queryByRole('button', { name: '编辑消息' })).not.toBeInTheDocument();

    fireEvent.click(within(userBubble).getByRole('button', { name: '编辑消息' }));
    const editor = await screen.findByRole('textbox', { name: '编辑消息内容' });
    expect(editor).toHaveValue('你认为呢');
    fireEvent.change(editor, { target: { value: '你先说' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // The edit generates one turn carrying the rewritten text, and optimistically
    // drops the old branch (the original message + the reply that followed it).
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]).toMatchObject({
      edit_of_message_id: 'm-2',
      input: { type: 'text', text: '你先说' }
    });
    await waitFor(() => expect(screen.getByText('你先说')).toBeInTheDocument());
    expect(screen.queryByText('你认为呢')).not.toBeInTheDocument();
    expect(screen.queryByText('我认为该出发了。')).not.toBeInTheDocument();
  });
});
