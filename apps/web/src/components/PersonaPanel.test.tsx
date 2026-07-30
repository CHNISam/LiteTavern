import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLoreDatabaseForTests } from '../lib/lore-store';
import {
  createPersona,
  listPersonas,
  readConversationPersona
} from '../lib/persona';
import { ConversationPersonaPanel, PersonaPanel } from './PersonaPanel';

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await resetLoreDatabaseForTests();
});

describe('PersonaPanel', () => {
  it('lists browser-local personas and their runtime position', async () => {
    await createPersona({
      name: '林岸',
      description: '一名夜班记者。',
      position: 'AT_DEPTH',
      depth: 3,
      role: 'user'
    });

    render(<PersonaPanel open onClose={() => {}} />);

    expect(await screen.findByText('林岸')).toBeInTheDocument();
    expect(screen.getByText('一名夜班记者。')).toBeInTheDocument();
    expect(screen.getByText('默认')).toBeInTheDocument();
    expect(screen.getByText(/AT_DEPTH · depth 3 · user/)).toBeInTheDocument();
    expect(screen.getByText(/仅保存在此设备/)).toBeInTheDocument();
  });

  it('creates a persona and reloads the local list', async () => {
    render(<PersonaPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /新建身份/ }));
    fireEvent.change(screen.getByLabelText('身份名称'), {
      target: { value: '沈迟' }
    });
    fireEvent.change(screen.getByLabelText('身份描述'), {
      target: { value: '外科医生。' }
    });
    fireEvent.click(screen.getByRole('button', { name: /保存身份/ }));

    await waitFor(() => expect(screen.getByText('沈迟')).toBeInTheDocument());
    expect(await listPersonas()).toEqual([
      expect.objectContaining({ name: '沈迟', description: '外科医生。' })
    ]);
  });

  it('promotes another persona to the default', async () => {
    await createPersona({ name: '林岸', description: '' });
    await createPersona({ name: '沈迟', description: '' });
    render(<PersonaPanel open onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText('把 沈迟 设为默认身份'));

    await waitFor(async () => {
      const personas = await listPersonas();
      expect(personas.find((item) => item.name === '沈迟')?.is_default).toBe(
        true
      );
    });
  });

  it('deletes a persona after the user confirms', async () => {
    await createPersona({ name: '林岸', description: '' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PersonaPanel open onClose={() => {}} />);

    fireEvent.click(await screen.findByLabelText('删除身份 林岸'));

    expect(await screen.findByText(/还没有身份/)).toBeInTheDocument();
    expect(await listPersonas()).toEqual([]);
  });

  it('does not call the legacy Cloud Persona API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<PersonaPanel open onClose={() => {}} />);
    expect(await screen.findByText(/还没有身份/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ConversationPersonaPanel', () => {
  it('binds the chosen persona to this conversation only', async () => {
    const first = await createPersona({ name: '林岸', description: '' });
    const second = await createPersona({ name: '沈迟', description: '' });
    const bound = vi.fn();
    render(
      <ConversationPersonaPanel
        open
        conversationId="conversation-1"
        personaId={first.persona_id}
        onClose={() => {}}
        onBound={bound}
      />
    );

    fireEvent.click(await screen.findByText('沈迟'));

    await waitFor(() =>
      expect(bound).toHaveBeenCalledWith(second.persona_id)
    );
    expect(await readConversationPersona('conversation-1')).toBe(
      second.persona_id
    );
  });

  it('can run a conversation without any persona', async () => {
    const persona = await createPersona({ name: '林岸', description: '' });
    const bound = vi.fn();
    render(
      <ConversationPersonaPanel
        open
        conversationId="conversation-1"
        personaId={persona.persona_id}
        onClose={() => {}}
        onBound={bound}
      />
    );

    fireEvent.click(await screen.findByText('不使用身份'));

    await waitFor(() => expect(bound).toHaveBeenCalledWith(null));
    expect(await readConversationPersona('conversation-1')).toBeNull();
  });
});
