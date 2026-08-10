import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRepository, resetChatRepositoryForTests } from '../lib/chat-repository';
import { saveLocalCharacter } from '../lib/character-card';
import { CharacterEditor } from './CharacterEditor';

vi.mock('../lib/avatar-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/avatar-image')>();
  return { ...actual, processAvatarImage: vi.fn().mockResolvedValue(
    new Blob(['avatar'], { type: 'image/webp' })) };
});

const PARTITION = 'test';
const MODEL = {
  name: '旧名字', description: '描述', personality: '人格', scenario: '场景',
  first_message: '你好', alternate_greetings: ['备用'], example_messages: '示例',
  system_prompt: '系统', post_history_instructions: '后置', tags: ['标签'],
  creator: { name: '作者', notes: '说明', character_version: '1' }
};

beforeEach(() => resetChatRepositoryForTests());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CharacterEditor local repository flow', () => {
  it('shows compatibility metadata and saves supported edits without HTTP', async () => {
    await saveLocalCharacter({ partition: PARTITION, characterId: 'card-1', model: MODEL,
      detail: { normalized_data: MODEL, source_metadata: {
        compatibility_level: 'FORMAL', format: 'CHARACTER_CARD_V3', container: 'PNG',
        unapplied_fields: ['data.character_book']
      }, warnings: ['角色知识书已保留。'] } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<CharacterEditor open partition={PARTITION} characterId="card-1"
      onClose={() => undefined} onSaved={onSaved} />);
    expect(await screen.findByText(/character_book/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }),
      { target: { value: '新名字' } });
    const save = screen.getByRole('button', { name: '保存角色' });
    fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await expect(chatRepository.getCharacter(PARTITION, 'card-1'))
      .resolves.toMatchObject({
        name: '新名字',
        local_card: { normalized_data: {
          name: '新名字', system_prompt: '系统', personality: '人格'
        } }
      });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates without an avatar entirely offline', async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<CharacterEditor open partition={PARTITION} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }),
      { target: { value: '无头像也能创建' } });
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.any(String)));
    await expect(chatRepository.listCharacters(PARTITION))
      .resolves.toEqual([expect.objectContaining({ name: '无头像也能创建' })]);
  });

  it('stores an edited avatar in the local character record', async () => {
    await saveLocalCharacter({ partition: PARTITION, characterId: 'card-2', model: MODEL });
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<CharacterEditor open partition={PARTITION} characterId="card-2"
      onClose={() => undefined} onSaved={onSaved} />);
    await screen.findByDisplayValue('旧名字');
    fireEvent.change(screen.getByLabelText('选择头像'), { target: {
      files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] } });
    await screen.findByAltText('头像预览');
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect((await chatRepository.getCharacter(PARTITION, 'card-2'))?.avatar_seed)
      .toMatch(/^data:image\/webp;base64,/);
  });

  it('encodes the avatar from the crop as it stands at save time', async () => {
    const { processAvatarImage } = await import('../lib/avatar-image');
    vi.mocked(processAvatarImage).mockClear();
    render(<CharacterEditor open partition={PARTITION} onClose={() => undefined}
      onSaved={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '有头像' } });
    fireEvent.change(screen.getByLabelText('选择头像'), { target: {
      files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] } });
    const preview = await screen.findByAltText('头像预览');
    Object.defineProperty(preview, 'naturalWidth', { value: 900, configurable: true });
    Object.defineProperty(preview, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(preview);
    fireEvent.change(await screen.findByLabelText('缩放'), { target: { value: '2' } });
    expect(processAvatarImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(processAvatarImage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(processAvatarImage).mock.calls[0]![1]).toMatchObject({ zoom: 2 });
  });
});
