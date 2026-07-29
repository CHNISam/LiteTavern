import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterWorldbookPanel, WorldbookPanel } from './WorldbookPanel';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function book(overrides: Record<string, unknown> = {}) {
  return {
    worldbook_id: 'book-1',
    name: '白港设定集',
    description: '',
    enabled: true,
    scan_depth: null,
    token_budget: null,
    origin: 'USER',
    entry_count: 2,
    ...overrides
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    entry_id: 'entry-1',
    worldbook_id: 'book-1',
    title: '白港',
    content: '白港是帝国最大的港口。',
    keys: ['白港'],
    selective: false,
    secondary_keys: [],
    selective_logic: 'AND_ANY',
    constant: false,
    enabled: true,
    case_sensitive: false,
    match_whole_words: false,
    position: 'AFTER_CHAR',
    insertion_order: 100,
    priority: null,
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorldbookPanel', () => {
  it('lists worldbooks and marks the one that came from a character card', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) === '/v1/worldbooks') {
        return json({
          worldbooks: [
            book(),
            book({ worldbook_id: 'book-2', name: '深夜电台设定', origin: 'CHARACTER_BOOK' })
          ]
        });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<WorldbookPanel open onClose={() => {}} />);

    expect(await screen.findByText('白港设定集')).toBeInTheDocument();
    expect(screen.getByText('角色卡自带')).toBeInTheDocument();
    expect(screen.getAllByText('2 条设定')).toHaveLength(2);
  });

  it('opens a book, shows its entries, and adds a new one', async () => {
    const posted: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/worldbooks' && (!init?.method || init.method === 'GET')) {
        return json({ worldbooks: [book()] });
      }
      if (path === '/v1/worldbooks/book-1/entries' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return json({ entry_id: 'entry-2' }, 201);
      }
      if (path === '/v1/worldbooks/book-1') {
        return json({
          worldbook: book(),
          entries: posted.length
            ? [entry(), entry({ entry_id: 'entry-2', title: '铁卫', content: '铁卫效忠皇室。' })]
            : [entry()]
        });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<WorldbookPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('打开世界书 白港设定集'));

    expect(await screen.findByText('白港是帝国最大的港口。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /新增条目/ }));
    fireEvent.change(screen.getByLabelText('条目标题'), { target: { value: '铁卫' } });
    fireEvent.change(screen.getByLabelText('条目内容'), { target: { value: '铁卫效忠皇室。' } });
    fireEvent.change(screen.getByLabelText('触发关键词'), { target: { value: '铁卫, 卫兵' } });
    fireEvent.click(screen.getByRole('button', { name: /添加条目/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      title: '铁卫',
      content: '铁卫效忠皇室。',
      keys: ['铁卫', '卫兵'],
      constant: false,
      position: 'AFTER_CHAR'
    });
    expect(await screen.findByText('铁卫效忠皇室。')).toBeInTheDocument();
  });

  it('creates a constant entry without keywords', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/worldbooks' && (!init?.method || init.method === 'GET')) {
        return json({ worldbooks: [book({ entry_count: 0 })] });
      }
      if (path === '/v1/worldbooks/book-1/entries' && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return json({ entry_id: 'entry-9' }, 201);
      }
      if (path === '/v1/worldbooks/book-1') {
        return json({ worldbook: book({ entry_count: 0 }), entries: [] });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<WorldbookPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('打开世界书 白港设定集'));
    fireEvent.click(await screen.findByRole('button', { name: /新增条目/ }));
    fireEvent.change(screen.getByLabelText('条目内容'), { target: { value: '这个世界没有魔法。' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /添加条目/ }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ constant: true, keys: [] });
  });

  it('switches a whole book off without touching its entries', async () => {
    const patched: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/worldbooks/book-1' && init?.method === 'PATCH') {
        patched.push(JSON.parse(String(init.body)));
        return json({ worldbook_id: 'book-1' });
      }
      if (path === '/v1/worldbooks') {
        return json({ worldbooks: [book({ enabled: patched.length === 0 })] });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(<WorldbookPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('停用世界书 白港设定集'));

    await waitFor(() => expect(patched).toEqual([{ enabled: false }]));
    expect(await screen.findByText('已停用')).toBeInTheDocument();
  });

  it('hides the feature when the service has no worldbook API', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }, 404)
    );

    render(<WorldbookPanel open onClose={() => {}} />);

    expect(await screen.findByText(/还不支持世界书/)).toBeInTheDocument();
  });
});

describe('CharacterWorldbookPanel', () => {
  it('links and unlinks a book, sending the whole desired end state', async () => {
    const sent: unknown[] = [];
    let linked: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/worldbooks') return json({ worldbooks: [book()] });
      if (path === '/v1/characters/character-1/worldbooks' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          worldbooks: { worldbook_id: string }[];
        };
        sent.push(body);
        linked = body.worldbooks.map((item) => ({
          worldbook_id: item.worldbook_id,
          name: '白港设定集',
          enabled: true,
          link_enabled: true,
          entry_count: 2,
          origin: 'USER'
        }));
        return json({ worldbooks: linked });
      }
      if (path === '/v1/characters/character-1/worldbooks') {
        return json({ worldbooks: linked });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(
      <CharacterWorldbookPanel
        open
        characterId="character-1"
        characterName="星遥"
        onClose={() => {}}
      />
    );

    const option = await screen.findByRole('button', { pressed: false });
    fireEvent.click(option);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ worldbooks: [{ worldbook_id: 'book-1' }] });

    await screen.findByRole('button', { pressed: true });
    fireEvent.click(screen.getByRole('button', { pressed: true }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ worldbooks: [] });
  });

  it('points the user at the settings panel when there is nothing to link yet', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/worldbooks') return json({ worldbooks: [] });
      if (path === '/v1/characters/character-1/worldbooks') return json({ worldbooks: [] });
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });

    render(
      <CharacterWorldbookPanel
        open
        characterId="character-1"
        characterName="星遥"
        onClose={() => {}}
      />
    );

    expect(await screen.findByText(/还没有世界书/)).toBeInTheDocument();
  });
});
