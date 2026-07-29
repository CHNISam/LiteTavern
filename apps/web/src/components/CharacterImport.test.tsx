import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAvatarImage } from '../lib/avatar-image';
import { CharacterImport } from './CharacterImport';

vi.mock('../lib/avatar-image', () => ({
  processAvatarImage: vi.fn()
}));

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

const preview = {
  format: 'CCV3_PNG',
  spec_version: '3.0',
  character: {
    name: '卡片角色',
    description: '描述',
    personality: '人格',
    firstMessage: '你好'
  },
  compatibility: { level: 'FORMAL', unapplied_fields: [] },
  warnings: []
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(processAvatarImage).mockReset();
  delete window.__LITETAVERN__;
});

describe('CharacterImport avatar handling', () => {
  it('sends multipart requests to the configured cross-origin Cloud API', async () => {
    window.__LITETAVERN__ = { cloudBaseUrl: 'https://api-internal.example' };
    vi.mocked(processAvatarImage).mockRejectedValue(new Error('no avatar needed'));
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      requests.push(String(input));
      return json(preview);
    });
    render(
      <CharacterImport
        open
        onClose={() => undefined}
        onImported={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: { files: [new File(['{}'], 'card.json', { type: 'application/json' })] }
    });

    await screen.findByText('卡片角色');
    expect(requests[0]).toBe(
      'https://api-internal.example/v1/characters/import/preview'
    );
  });

  it('shows a readable Cloud error when Pages returns an empty API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    render(
      <CharacterImport
        open
        onClose={() => undefined}
        onImported={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: { files: [new File(['png'], 'card.png', { type: 'image/png' })] }
    });

    expect(
      await screen.findByText('LiteTavern Cloud 暂不可用，请稍后重试。')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected end of JSON input/)).not.toBeInTheDocument();
  });

  it('uploads a processed card avatar after the card data commits', async () => {
    vi.mocked(processAvatarImage).mockResolvedValue(
      new Blob(['square-avatar'], { type: 'image/webp' })
    );
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      paths.push(path);
      if (path === '/v1/characters/import/preview') return json(preview);
      if (path === '/v1/characters/import') return json({ character_id: 'card-1' }, 201);
      if (path === '/v1/characters/card-1/avatar') return json({ avatar_updated: true });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(<CharacterImport open onClose={() => undefined} onImported={onImported} />);

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: { files: [new File(['png'], 'card.png', { type: 'image/png' })] }
    });
    expect(await screen.findByAltText('角色卡头像预览')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(paths).toContain('/v1/characters/card-1/avatar');
  });

  it('continues importing card data when avatar decoding fails', async () => {
    vi.mocked(processAvatarImage).mockRejectedValue(new Error('damaged pixels'));
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/characters/import/preview') return json(preview);
      if (path === '/v1/characters/import') return json({ character_id: 'card-2' }, 201);
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(<CharacterImport open onClose={() => undefined} onImported={onImported} />);

    fireEvent.change(screen.getByLabelText('选择角色卡文件'), {
      target: { files: [new File(['png'], 'card.png', { type: 'image/png' })] }
    });
    expect(await screen.findByText(/头像无法读取/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });
});
