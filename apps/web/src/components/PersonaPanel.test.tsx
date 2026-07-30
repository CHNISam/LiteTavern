import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationPersonaPanel, PersonaPanel } from './PersonaPanel';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function persona(overrides: Record<string, unknown> = {}) {
  return {
    persona_id: 'persona-1',
    name: '林岸',
    description: '一名夜班记者。',
    is_default: true,
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PersonaPanel', () => {
  it('lists the personas a user can speak as', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) === '/v1/personas') return json({ personas: [persona()] });
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<PersonaPanel open onClose={() => {}} />);

    expect(await screen.findByText('林岸')).toBeInTheDocument();
    expect(screen.getByText('一名夜班记者。')).toBeInTheDocument();
    expect(screen.getByText('默认')).toBeInTheDocument();
  });

  it('creates a persona and reloads the list', async () => {
    const requests: { path: string; method?: string; body?: unknown }[] = [];
    let created = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      requests.push({
        path,
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (path === '/v1/personas' && init?.method === 'POST') {
        created = true;
        return json({ persona: persona({ name: '沈迟' }) }, 201);
      }
      if (path === '/v1/personas') {
        return json({ personas: created ? [persona({ name: '沈迟' })] : [] });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<PersonaPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建身份/ }));
    fireEvent.change(screen.getByLabelText('身份名称'), { target: { value: '沈迟' } });
    fireEvent.change(screen.getByLabelText('身份描述'), { target: { value: '外科医生。' } });
    fireEvent.click(screen.getByRole('button', { name: /保存身份/ }));

    await waitFor(() => expect(screen.getByText('沈迟')).toBeInTheDocument());
    const post = requests.find((request) => request.method === 'POST');
    expect(post?.body).toEqual({ name: '沈迟', description: '外科医生。' });
  });

  it('promotes another persona to the default', async () => {
    const patched: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/personas/persona-2' && init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)));
        return json({ persona: persona({ persona_id: 'persona-2', is_default: true }) });
      }
      if (path === '/v1/personas') {
        return json({
          personas: [
            persona(),
            persona({ persona_id: 'persona-2', name: '沈迟', is_default: false })
          ]
        });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<PersonaPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('把 沈迟 设为默认身份'));

    await waitFor(() => expect(patched).toEqual([{ is_default: true }]));
  });

  it('deletes a persona after the user confirms', async () => {
    const deleted: string[] = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/personas/persona-1' && init?.method === 'DELETE') {
        deleted.push(path);
        return json({ deleted: true });
      }
      if (path === '/v1/personas') {
        return json({ personas: deleted.length ? [] : [persona()] });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<PersonaPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('删除身份 林岸'));

    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(await screen.findByText(/还没有身份/)).toBeInTheDocument();
  });

  it('hides the feature instead of reporting an error when the service has no persona API', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }, 404)
    );

    render(<PersonaPanel open onClose={() => {}} />);

    expect(await screen.findByText(/还不支持用户身份/)).toBeInTheDocument();
    expect(screen.queryByText('接口不存在。')).not.toBeInTheDocument();
  });

  it('also recognises a framework 404 from a Cloud build older than this feature', async () => {
    // Fastify's own not-found handler answers without any LiteTavern error code.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ message: 'Route GET:/v1/personas not found', error: 'Not Found', statusCode: 404 }, 404)
    );

    render(<PersonaPanel open onClose={() => {}} />);

    expect(await screen.findByText(/还不支持用户身份/)).toBeInTheDocument();
  });
});

describe('ConversationPersonaPanel', () => {
  it('binds the chosen persona to this conversation only', async () => {
    const requests: { path: string; method?: string; body?: unknown }[] = [];
    const bound = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      requests.push({
        path,
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (path === '/v1/personas') {
        return json({
          personas: [
            persona(),
            persona({ persona_id: 'persona-2', name: '沈迟', is_default: false })
          ]
        });
      }
      if (path === '/v1/conversations/conversation-1/persona') {
        return json({ conversation_id: 'conversation-1', persona_id: 'persona-2' });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(
      <ConversationPersonaPanel
        open
        conversationId="conversation-1"
        personaId="persona-1"
        onClose={() => {}}
        onBound={bound}
      />
    );
    fireEvent.click(await screen.findByText('沈迟'));

    await waitFor(() => expect(bound).toHaveBeenCalledWith('persona-2'));
    expect(
      requests.find((request) => request.path === '/v1/conversations/conversation-1/persona')
    ).toMatchObject({ method: 'PUT', body: { persona_id: 'persona-2' } });
  });

  it('can run a conversation without any persona', async () => {
    const bound = vi.fn();
    let sent: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/personas') return json({ personas: [persona()] });
      if (path === '/v1/conversations/conversation-1/persona') {
        sent = JSON.parse(String(init?.body));
        return json({ conversation_id: 'conversation-1', persona_id: null });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(
      <ConversationPersonaPanel
        open
        conversationId="conversation-1"
        personaId="persona-1"
        onClose={() => {}}
        onBound={bound}
      />
    );
    fireEvent.click(await screen.findByText('不使用身份'));

    await waitFor(() => expect(bound).toHaveBeenCalledWith(null));
    expect(sent).toEqual({ persona_id: null });
  });
});
