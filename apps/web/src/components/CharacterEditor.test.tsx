import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterEditor } from './CharacterEditor';

vi.mock('../lib/avatar-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/avatar-image')>();
  return {
    ...actual,
    processAvatarImage: vi.fn().mockResolvedValue(
      new Blob(['avatar'], { type: 'image/webp' })
    )
  };
});

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

describe('CharacterEditor', () => {
  it('shows compatibility and unapplied content, then saves supported edits', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      requests.push({ path, ...(init ? { init } : {}) });
      if (path === '/v1/characters/card-1/card' && (!init?.method || init.method === 'GET')) {
        return json({
          normalized_data: {
            name: '旧名字',
            description: '描述',
            personality: '人格',
            scenario: '场景',
            first_message: '你好',
            alternate_greetings: ['备用'],
            example_messages: '示例',
            system_prompt: '系统',
            post_history_instructions: '后置',
            tags: ['标签'],
            creator: { name: '作者', notes: '说明', character_version: '1' }
          },
          source_metadata: {
            compatibility_level: 'FORMAL',
            format: 'CHARACTER_CARD_V3',
            container: 'PNG',
            unapplied_fields: ['data.character_book', 'data.extensions']
          },
          warnings: ['角色知识书已保留，但当前不会参与运行。']
        });
      }
      if (path === '/v1/characters/card-1/card' && init?.method === 'PUT') {
        return json({ character_id: 'card-1' });
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    const onSaved = vi.fn().mockResolvedValue(undefined);

    render(<CharacterEditor open characterId="card-1" onClose={() => undefined} onSaved={onSaved} />);

    expect(await screen.findByText('正式支持')).toBeInTheDocument();
    expect(screen.getByText(/character_book/)).toBeInTheDocument();
    expect(screen.getByText(/当前不会参与运行/)).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: '名称' });
    fireEvent.change(name, { target: { value: '新名字' } });
    const save = screen.getByRole('button', { name: '保存角色' });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('card-1'));
    const update = requests.find((request) => request.init?.method === 'PUT');
    expect(JSON.parse(String(update?.init?.body))).toMatchObject({ name: '新名字' });
    expect(requests.filter((request) => request.init?.method === 'PUT')).toHaveLength(1);
  });

  it('creates without an avatar and keeps the form visible when avatar upload fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/characters' && init?.method === 'POST') {
        return json({ character_id: 'new-card' }, 201);
      }
      if (path === '/v1/characters/new-card/avatar' && init?.method === 'POST') {
        return json({ error: { message: '头像上传失败' } }, 500);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<CharacterEditor open onClose={() => undefined} onSaved={onSaved} />);

    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), {
      target: { value: '无头像也能创建' }
    });
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new-card'));
  });

  it('reports avatar upload failure after preserving the edited character fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/characters/card-2/card' && (!init?.method || init.method === 'GET')) {
        return json({
          normalized_data: {
            name: '角色',
            description: '',
            personality: '',
            scenario: '',
            first_message: '',
            alternate_greetings: [],
            example_messages: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: { name: '', notes: '', character_version: '' }
          },
          source_metadata: {
            compatibility_level: 'FORMAL',
            format: 'INTERNAL',
            container: 'INTERNAL',
            unapplied_fields: []
          },
          warnings: []
        });
      }
      if (path === '/v1/characters/card-2/card' && init?.method === 'PUT') {
        return json({ character_id: 'card-2' });
      }
      if (path === '/v1/characters/card-2/avatar' && init?.method === 'POST') {
        return json({ error: { message: '头像上传失败' } }, 500);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<CharacterEditor open characterId="card-2" onClose={() => undefined} onSaved={vi.fn()} />);
    expect(await screen.findByDisplayValue('角色')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择头像'), {
      target: { files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(screen.getByAltText('头像预览').getAttribute('src')).toMatch(/^blob:/));
    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    expect(await screen.findByText(/角色资料已保存，但头像上传失败/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('角色')).toBeInTheDocument();
  });

  /**
   * The cropper hands back a producer rather than a finished Blob, so the crop
   * that gets encoded is the one on screen when the user saves — including an
   * adjustment made immediately before pressing the button.
   */
  it('encodes the avatar from the crop as it stands at save time', async () => {
    const { processAvatarImage } = await import('../lib/avatar-image');
    // The module mock is shared across the file; restoreAllMocks does not reset it.
    vi.mocked(processAvatarImage).mockClear();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/characters' && init?.method === 'POST') {
        return json({ character_id: 'new-card' }, 201);
      }
      if (path === '/v1/characters/new-card/avatar') return json({ uploaded: true });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<CharacterEditor open onClose={() => undefined} onSaved={onSaved} />);

    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), {
      target: { value: '有头像' }
    });
    fireEvent.change(screen.getByLabelText('选择头像'), {
      target: { files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] }
    });
    const preview = await screen.findByAltText('头像预览');
    // jsdom reports no intrinsic size, so the natural dimensions are supplied.
    Object.defineProperty(preview, 'naturalWidth', { value: 900, configurable: true });
    Object.defineProperty(preview, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(preview);

    fireEvent.change(await screen.findByLabelText('缩放'), { target: { value: '2' } });
    // Nothing is encoded while adjusting.
    expect(processAvatarImage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(processAvatarImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(processAvatarImage).mock.calls[0]![1]).toMatchObject({ zoom: 2 });
  });
});
