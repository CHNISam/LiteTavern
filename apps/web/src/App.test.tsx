import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
