import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLoreDatabaseForTests } from '../lib/lore-store';
import {
  characterWorldbookIds,
  createWorldbook,
  createWorldbookEntry,
  listWorldbooks,
  readWorldbook
} from '../lib/worldbook';
import { CharacterWorldbookPanel, WorldbookPanel } from './WorldbookPanel';

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await resetLoreDatabaseForTests();
});

async function seedBook(
  name = '白港设定集',
  origin: 'USER' | 'CHARACTER_BOOK' = 'USER'
) {
  const worldbookId = await createWorldbook({ name, origin });
  await createWorldbookEntry(worldbookId, {
    title: '白港',
    content: '白港是帝国最大的港口。',
    keys: ['白港'],
    constant: false,
    enabled: true,
    position: 'AFTER_CHAR',
    insertion_order: 100
  });
  return worldbookId;
}

describe('WorldbookPanel', () => {
  it('lists local worldbooks and marks the one from a character card', async () => {
    await seedBook();
    await seedBook('深夜电台设定', 'CHARACTER_BOOK');
    render(<WorldbookPanel open onClose={() => {}} />);

    expect(await screen.findByText('白港设定集')).toBeInTheDocument();
    expect(screen.getByText('角色卡自带')).toBeInTheDocument();
    expect(screen.getAllByText('1 条设定')).toHaveLength(2);
    expect(screen.getByText(/仅保存在此设备/)).toBeInTheDocument();
  });

  it('opens a book, shows its entries, and adds a new one', async () => {
    const worldbookId = await seedBook();
    render(<WorldbookPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('打开世界书 白港设定集'));
    expect(
      await screen.findByText('白港是帝国最大的港口。')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /新增条目/ }));
    fireEvent.change(screen.getByLabelText('条目标题'), {
      target: { value: '铁卫' }
    });
    fireEvent.change(screen.getByLabelText('条目内容'), {
      target: { value: '铁卫效忠皇室。' }
    });
    fireEvent.change(screen.getByLabelText('触发关键词'), {
      target: { value: '铁卫, 卫兵' }
    });
    fireEvent.click(screen.getByRole('button', { name: /添加条目/ }));

    expect(await screen.findByText('铁卫效忠皇室。')).toBeInTheDocument();
    const detail = await readWorldbook(worldbookId);
    expect(detail.entries).toContainEqual(
      expect.objectContaining({
        title: '铁卫',
        keys: ['铁卫', '卫兵'],
        constant: false
      })
    );
  });

  it('creates a constant entry without keywords', async () => {
    const worldbookId = await createWorldbook('白港设定集');
    render(<WorldbookPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('打开世界书 白港设定集'));
    fireEvent.click(await screen.findByRole('button', { name: /新增条目/ }));
    fireEvent.change(screen.getByLabelText('条目内容'), {
      target: { value: '这个世界没有魔法。' }
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /添加条目/ }));

    await screen.findByText('这个世界没有魔法。');
    expect((await readWorldbook(worldbookId)).entries[0]).toMatchObject({
      constant: true,
      keys: []
    });
  });

  it('switches a whole book off without touching its entries', async () => {
    const worldbookId = await seedBook();
    render(<WorldbookPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByLabelText('停用世界书 白港设定集'));

    expect(await screen.findByText('已停用')).toBeInTheDocument();
    const detail = await readWorldbook(worldbookId);
    expect(detail.worldbook.enabled).toBe(false);
    expect(detail.entries).toHaveLength(1);
  });

  it('does not call the legacy Cloud worldbook API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<WorldbookPanel open onClose={() => {}} />);
    expect(await screen.findByText(/还没有世界书/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CharacterWorldbookPanel', () => {
  it('links and unlinks a book as one local desired state', async () => {
    const worldbookId = await seedBook();
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
    await waitFor(async () =>
      expect(await characterWorldbookIds('character-1')).toEqual([
        worldbookId
      ])
    );
    fireEvent.click(screen.getByRole('button', { pressed: true }));
    await waitFor(async () =>
      expect(await characterWorldbookIds('character-1')).toEqual([])
    );
  });

  it('points the user at settings when there is nothing to link yet', async () => {
    render(
      <CharacterWorldbookPanel
        open
        characterId="character-1"
        characterName="星遥"
        onClose={() => {}}
      />
    );

    expect(await screen.findByText(/还没有世界书/)).toBeInTheDocument();
    expect(await listWorldbooks()).toEqual([]);
  });
});
