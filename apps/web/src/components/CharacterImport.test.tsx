import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processAvatarImage } from '../lib/avatar-image';
import { chatRepository, resetChatRepositoryForTests } from '../lib/chat-repository';
import { storeImportedCardExtensions } from '../lib/local-card-assets';
import { CharacterImport } from './CharacterImport';

vi.mock('../lib/avatar-image', () => ({ processAvatarImage: vi.fn() }));
vi.mock('../lib/local-card-assets', () => ({ storeImportedCardExtensions: vi.fn() }));
const PARTITION = 'test';
const card = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
  name: '卡片角色', description: '描述', personality: '人格', first_mes: '你好', extensions: {} } });

beforeEach(() => resetChatRepositoryForTests());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(processAvatarImage).mockReset();
  vi.mocked(storeImportedCardExtensions).mockReset(); });

function renderImport(onImported = vi.fn().mockResolvedValue(undefined)) {
  render(<CharacterImport partition={PARTITION} open onClose={() => undefined} onImported={onImported} />);
  return onImported;
}

describe('CharacterImport local extension flow', () => {
  it('previews and imports locally without any HTTP request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onImported = renderImport();
    fireEvent.change(screen.getByLabelText('选择角色卡文件'), { target: {
      files: [new File([card], 'card.json', { type: 'application/json' })] } });
    await screen.findByText('卡片角色');
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.any(String)));
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(chatRepository.listCharacters(PARTITION))
      .resolves.toEqual([expect.objectContaining({ name: '卡片角色' })]);
  });

  it('does not turn Cloud unavailability into an import error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const onImported = renderImport();
    fireEvent.change(screen.getByLabelText('选择角色卡文件'), { target: {
      files: [new File([card], 'card.json', { type: 'application/json' })] } });
    await screen.findByText('卡片角色');
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(screen.queryByText(/Cloud 暂不可用/)).not.toBeInTheDocument();
  });

  it('stores a processed PNG avatar in IndexedDB', async () => {
    vi.mocked(processAvatarImage).mockResolvedValue(new Blob(['square-avatar'], { type: 'image/webp' }));
    const onImported = renderImport();
    fireEvent.change(screen.getByLabelText('选择角色卡文件'), { target: {
      files: [new File([card], 'card.png', { type: 'image/png' })] } });
    await screen.findByAltText('角色卡头像预览');
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect((await chatRepository.listCharacters(PARTITION))[0]?.avatar_seed)
      .toMatch(/^data:image\/webp;base64,/);
  });

  it('continues importing card data when avatar decoding fails', async () => {
    vi.mocked(processAvatarImage).mockRejectedValue(new Error('damaged pixels'));
    const onImported = renderImport();
    fireEvent.change(screen.getByLabelText('选择角色卡文件'), { target: {
      files: [new File([card], 'card.png', { type: 'image/png' })] } });
    expect(await screen.findByText(/头像无法读取/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });
});
