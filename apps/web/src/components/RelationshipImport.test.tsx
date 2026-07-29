import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelationshipImport } from './RelationshipImport';
import { UNIFIED_RELATIONSHIP_MIGRATION_PROMPT } from '../lib/migration-prompts';
import type { Character } from '../lib/api';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const SUMMARY = '你们从听众关系变成了会互相报备的人。';
const MEMORY_ONE = '她答应过每晚十一点提醒你休息。';
const MEMORY_TWO = '你们一起听完了最后一期节目。';

const preview = {
  character: {
    name: '星遥',
    description: '深夜电台主播',
    personality_traits: ['温柔'],
    speaking_style: ['句尾常带语气词']
  },
  user_profile: {
    preferred_name: '小满',
    facts: ['是自由撰稿人'],
    preferences: [],
    boundaries: []
  },
  relationship: {
    summary: SUMMARY,
    stage: '暧昧期',
    user_addressing: ['小满'],
    interaction_patterns: ['深夜互道晚安']
  },
  memories: [
    {
      key: 'm0',
      content: MEMORY_ONE,
      importance: 9,
      approximate_time: '2026-05',
      tags: ['约定'],
      evidence_summary: ''
    },
    {
      key: 'm1',
      content: MEMORY_TWO,
      importance: 7,
      approximate_time: null,
      tags: [],
      evidence_summary: ''
    }
  ],
  unfinished_threads: ['说好要一起跨年'],
  uncertain_items: [{ content: '她可能有一只猫。', reason: '只提过一次。' }],
  source_metadata: {
    source_platform: 'doubao',
    character_name_on_source: '星遥',
    processed_at: null,
    notes: ''
  },
  counts: { memories: 2, uncertain_items: 1, unfinished_threads: 1, duplicate_memories: 0 }
};

const ownedCharacter: Character = {
  character_id: 'char-1',
  name: '我自己的角色',
  profile_summary: '',
  personality_summary: '',
  first_message: '',
  avatar_seed: '',
  is_owned: true
};

function validJson() {
  return JSON.stringify({ schema_version: 'litetavern_relationship_import_v1' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockApi(handlers: Record<string, () => Promise<Response>>) {
  const calls: { path: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    calls.push({
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null
    });
    const handler = handlers[path];
    if (handler) return handler();
    return json({}, 200);
  });
  return calls;
}

async function goToPreview() {
  fireEvent.click(screen.getByRole('button', { name: '进入导入' }));
  fireEvent.change(screen.getByLabelText('粘贴迁移 JSON'), { target: { value: validJson() } });
  fireEvent.click(screen.getByRole('button', { name: /校验数据/ }));
  await screen.findByLabelText('角色名称');
}

describe('RelationshipImport', () => {
  it('offers exactly one unified migration prompt for copying', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockApi({});
    render(
      <RelationshipImport
        open
        characters={[]}
        onClose={() => undefined}
        onImported={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /复制迁移已有关系 Prompt/ }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(UNIFIED_RELATIONSHIP_MIGRATION_PROMPT)
    );
    expect(screen.queryByRole('button', { name: /分批|合并/ })).not.toBeInTheDocument();
  });

  it('rejects a file that is not .json without reading it', async () => {
    mockApi({});
    render(
      <RelationshipImport
        open
        characters={[]}
        onClose={() => undefined}
        onImported={async () => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '进入导入' }));
    fireEvent.change(screen.getByLabelText('选择迁移 JSON 文件'), {
      target: { files: [new File(['# 聊天记录'], 'chat.md', { type: 'text/markdown' })] }
    });
    expect(await screen.findByText(/只支持 .json 文件/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /校验数据/ })).toBeDisabled();
  });

  it('rejects a file over the size limit', async () => {
    mockApi({});
    render(
      <RelationshipImport
        open
        characters={[]}
        onClose={() => undefined}
        onImported={async () => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '进入导入' }));
    const oversized = new File(['x'.repeat(1024 * 1024 + 1)], 'big.json', {
      type: 'application/json'
    });
    fireEvent.change(screen.getByLabelText('选择迁移 JSON 文件'), {
      target: { files: [oversized] }
    });
    expect(await screen.findByText(/超过 1024 KB 上限/)).toBeInTheDocument();
  });

  it('shows a specific validation error instead of a generic failure', async () => {
    mockApi({
      '/v1/relationship-imports/validate': () =>
        json({
          valid: false,
          import_id: null,
          preview: null,
          unknown_fields: [],
          issues: [
            {
              severity: 'FATAL',
              code: 'SCHEMA_VERSION_UNSUPPORTED',
              path: 'schema_version',
              message: '不支持的 schema_version。'
            }
          ]
        })
    });
    render(
      <RelationshipImport
        open
        characters={[]}
        onClose={() => undefined}
        onImported={async () => undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '进入导入' }));
    fireEvent.change(screen.getByLabelText('粘贴迁移 JSON'), { target: { value: validJson() } });
    fireEvent.click(screen.getByRole('button', { name: /校验数据/ }));

    expect(await screen.findByText('不支持的 schema_version。')).toBeInTheDocument();
    expect(screen.getByText('schema_version')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回修改 JSON' })).toBeInTheDocument();
  });

  it('lets the user edit the preview, drop a memory, and commits only the confirmed data', async () => {
    const calls = mockApi({
      '/v1/relationship-imports/validate': () =>
        json({ valid: true, import_id: 'import-1', preview, unknown_fields: [], issues: [] }),
      '/v1/relationship-imports/commit': () =>
        json(
          {
            import_id: 'import-1',
            character_id: 'char-new',
            conversation_id: 'conv-new',
            created_character: true,
            memories_written: 1,
            already_committed: false
          },
          201
        )
    });
    const onImported = vi.fn().mockResolvedValue(undefined);
    render(
      <RelationshipImport
        open
        characters={[ownedCharacter]}
        onClose={() => undefined}
        onImported={onImported}
      />
    );
    await goToPreview();

    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '星遥（迁移）' } });
    fireEvent.click(screen.getByLabelText('导入记忆 m1'));

    fireEvent.click(screen.getByRole('button', { name: '下一步：确认导入' }));
    expect(await screen.findByText('将写入 1 条长期记忆')).toBeInTheDocument();
    expect(screen.getByText(/将创建 1 个角色：星遥（迁移）/)).toBeInTheDocument();
    expect(screen.getByText('将保留 1 条不确定信息')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());

    const commit = calls.find((call) => call.path === '/v1/relationship-imports/commit');
    const body = commit?.body as {
      import_id: string;
      mode: string;
      payload: { character: { name: string }; memories: { content: string }[] };
    };
    expect(body.import_id).toBe('import-1');
    expect(body.mode).toBe('CREATE');
    expect(body.payload.character.name).toBe('星遥（迁移）');
    // Only the memory the user kept is submitted, and uncertain items are never
    // promoted into the memory list on their own.
    expect(body.payload.memories.map((memory) => memory.content)).toEqual([MEMORY_ONE]);
  });

  it('commits into an existing owned character when that target is chosen', async () => {
    const calls = mockApi({
      '/v1/relationship-imports/validate': () =>
        json({ valid: true, import_id: 'import-2', preview, unknown_fields: [], issues: [] }),
      '/v1/relationship-imports/commit': () =>
        json(
          {
            import_id: 'import-2',
            character_id: 'char-1',
            conversation_id: 'conv-2',
            created_character: false,
            memories_written: 2,
            already_committed: false
          },
          201
        )
    });
    render(
      <RelationshipImport
        open
        characters={[ownedCharacter]}
        defaultCharacterId="char-1"
        onClose={() => undefined}
        onImported={async () => undefined}
      />
    );
    await goToPreview();
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认导入' }));
    expect(await screen.findByLabelText('选择已有角色')).toHaveValue('char-1');
    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }));

    await waitFor(() =>
      expect(calls.some((call) => call.path === '/v1/relationship-imports/commit')).toBe(true)
    );
    const body = calls.find((call) => call.path === '/v1/relationship-imports/commit')?.body as {
      mode: string;
      character_id: string;
      update_existing_character: boolean;
    };
    expect(body.mode).toBe('EXISTING');
    expect(body.character_id).toBe('char-1');
    // Overwriting the existing character's setup stays opt-in.
    expect(body.update_existing_character).toBe(false);
  });

  it('can promote an uncertain item into a real memory only on request', async () => {
    const calls = mockApi({
      '/v1/relationship-imports/validate': () =>
        json({ valid: true, import_id: 'import-3', preview, unknown_fields: [], issues: [] }),
      '/v1/relationship-imports/commit': () =>
        json(
          {
            import_id: 'import-3',
            character_id: 'char-new',
            conversation_id: 'conv-3',
            created_character: true,
            memories_written: 3,
            already_committed: false
          },
          201
        )
    });
    render(
      <RelationshipImport
        open
        characters={[]}
        onClose={() => undefined}
        onImported={async () => undefined}
      />
    );
    await goToPreview();
    fireEvent.click(screen.getByRole('button', { name: '转为正式记忆' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认导入' }));
    expect(await screen.findByText('将写入 3 条长期记忆')).toBeInTheDocument();
    expect(screen.getByText('将保留 0 条不确定信息')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.path === '/v1/relationship-imports/commit')).toBe(true)
    );
    const body = calls.find((call) => call.path === '/v1/relationship-imports/commit')?.body as {
      payload: { memories: { content: string }[]; uncertain_items: unknown[] };
    };
    expect(body.payload.memories.map((memory) => memory.content)).toContain('她可能有一只猫。');
    expect(body.payload.uncertain_items).toHaveLength(0);
  });
});
