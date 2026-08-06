import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAvatarImage } from '../lib/avatar-image';
import { storeImportedCardExtensions } from '../lib/local-card-assets';
import { CharacterImport } from './CharacterImport';

vi.mock('../lib/avatar-image', () => ({
  processAvatarImage: vi.fn()
}));
vi.mock('../lib/local-card-assets', () => ({
  storeImportedCardExtensions: vi.fn()
}));

const card = JSON.stringify({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '卡片角色',
    description: '描述',
    personality: '人格',
    first_mes: '你好',
    extensions: {}
  }
});

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(processAvatarImage).mockReset();
  vi.mocked(storeImportedCardExtensions).mockReset();
  delete window.__LITETAVERN__;
});

describe('CharacterImport local extension flow', () => {
  it('previews locally and uploads the card only once on confirmation', async () => {
    window.__LITETAVERN__ = { cloudBaseUrl: 'https://api-internal.example' };
    const requests: Array<{ url: string; body: FormData }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      requests.push({
        url: String(input),
        body: init?.body as FormData
      });
      return json({ character_id: 'card-1' }, 201);
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(
      <CharacterImport
        open
        onClose={() => undefined}
        onImported={onImported}
      />
    );

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: {
        files: [new File([card], 'card.json', { type: 'application/json' })]
      }
    });

    await screen.findByText('卡片角色');
    expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('card-1'));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api-internal.example/v1/characters/import'
    );
    expect(requests[0]?.body.get('asset_mode')).toBe(
      'LOCAL_EXTENSIONS_V1'
    );
    expect(storeImportedCardExtensions).toHaveBeenCalledWith(
      expect.any(Object),
      'card-1',
      '卡片角色',
      false
    );
  });

  it('shows a readable Cloud error only when confirmation cannot upload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 })
    );
    render(
      <CharacterImport
        open
        onClose={() => undefined}
        onImported={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: {
        files: [new File([card], 'card.json', { type: 'application/json' })]
      }
    });
    await screen.findByText('卡片角色');
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));

    expect(
      await screen.findByText('LiteTavern Cloud 暂不可用，请稍后重试。')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Unexpected end of JSON input/)
    ).not.toBeInTheDocument();
  });

  it('uploads a processed PNG avatar after the card data commits', async () => {
    vi.mocked(processAvatarImage).mockResolvedValue(
      new Blob(['square-avatar'], { type: 'image/webp' })
    );
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      paths.push(path);
      if (path === '/v1/characters/import') {
        return json({ character_id: 'card-1' }, 201);
      }
      if (path === '/v1/characters/card-1/avatar') {
        return json({ avatar_updated: true });
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(
      <CharacterImport
        open
        onClose={() => undefined}
        onImported={onImported}
      />
    );

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: { files: [new File([card], 'card.png', { type: 'image/png' })] }
    });
    expect(
      await screen.findByAltText('角色卡头像预览')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(paths).toEqual([
      '/v1/characters/import',
      '/v1/characters/card-1/avatar'
    ]);
  });

  it('continues importing card data when avatar decoding fails', async () => {
    vi.mocked(processAvatarImage).mockRejectedValue(
      new Error('damaged pixels')
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) === '/v1/characters/import') {
        return json({ character_id: 'card-2' }, 201);
      }
      return json({ error: { message: 'unexpected' } }, 404);
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(
      <CharacterImport
        open
        onClose={() => undefined}
        onImported={onImported}
      />
    );

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: { files: [new File([card], 'card.png', { type: 'image/png' })] }
    });
    expect(await screen.findByText(/头像无法读取/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });
});
