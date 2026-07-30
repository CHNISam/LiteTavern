import { useEffect, useState } from 'react';
import {
  ArrowLeft, BookOpen, Check, LoaderCircle, Plus, Trash2, X
} from 'lucide-react';
import {
  createWorldbook,
  createWorldbookEntry,
  deleteWorldbook,
  deleteWorldbookEntry,
  listCharacterWorldbooks,
  listWorldbooks,
  readWorldbook,
  setCharacterWorldbooks,
  updateWorldbook,
  updateWorldbookEntry,
  type CharacterWorldbookLink,
  type Worldbook,
  type WorldbookEntry,
  type WorldbookEntryDraft,
  type WorldbookPosition
} from '../lib/worldbook';

const UNAVAILABLE =
  '当前连接的服务还不支持世界书，升级 LiteTavern Cloud 后即可使用。';

const EMPTY_ENTRY: WorldbookEntryDraft = {
  title: '',
  content: '',
  keys: [],
  constant: false,
  enabled: true,
  position: 'AFTER_CHAR',
  insertion_order: 100
};

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function parseKeys(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 64);
}

function PanelShell({
  title,
  onClose,
  onBack,
  children
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel worldbook-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            {onBack && (
              <button type="button" className="app-settings-back" onClick={onBack}>
                <ArrowLeft size={16} /> 返回世界书列表
              </button>
            )}
            <span className="eyebrow">Worldbook</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={19} />
          </button>
        </header>
        <div className="worldbook-content">{children}</div>
      </section>
    </div>
  );
}

function EntryEditor({
  busy,
  onCancel,
  onSubmit
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: WorldbookEntryDraft) => void;
}) {
  const [draft, setDraft] = useState<WorldbookEntryDraft>(EMPTY_ENTRY);
  const [keyText, setKeyText] = useState('');

  return (
    <div className="editor-section worldbook-form">
      <h3>新增条目</h3>
      <label>
        条目标题（仅用于整理，不会进入对话）
        <input
          aria-label="条目标题"
          value={draft.title}
          maxLength={200}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </label>
      <label>
        条目内容
        <textarea
          aria-label="条目内容"
          value={draft.content}
          rows={4}
          maxLength={20000}
          placeholder="这条世界知识本身，会在命中时原样进入对话。"
          onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
        />
      </label>
      <label>
        触发关键词（逗号分隔）
        <input
          aria-label="触发关键词"
          value={keyText}
          disabled={draft.constant}
          placeholder="白港, White Harbor"
          onChange={(event) => setKeyText(event.target.value)}
        />
      </label>
      <label className="worldbook-checkbox">
        <input
          type="checkbox"
          checked={draft.constant}
          onChange={(event) =>
            setDraft((current) => ({ ...current, constant: event.target.checked }))
          }
        />
        常驻条目（不需要关键词，每轮都注入）
      </label>
      <label>
        注入位置
        <select
          aria-label="注入位置"
          value={draft.position}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              position: event.target.value as WorldbookPosition
            }))
          }
        >
          <option value="BEFORE_CHAR">角色设定之前</option>
          <option value="AFTER_CHAR">角色设定之后</option>
        </select>
      </label>
      <label>
        排序值（越大越靠近对话）
        <input
          aria-label="排序值"
          type="number"
          value={draft.insertion_order}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              insertion_order: Number(event.target.value) || 0
            }))
          }
        />
      </label>
      <div className="persona-form-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !draft.content.trim()}
          onClick={() => onSubmit({ ...draft, keys: parseKeys(keyText) })}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
          添加条目
        </button>
      </div>
    </div>
  );
}

/** Create and edit worldbooks and their entries. */
export function WorldbookPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [worldbooks, setWorldbooks] = useState<Worldbook[]>([]);
  const [supported, setSupported] = useState(true);
  const [selected, setSelected] = useState<Worldbook | null>(null);
  const [entries, setEntries] = useState<WorldbookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function reloadBooks() {
    setLoading(true);
    setError(null);
    try {
      const result = await listWorldbooks();
      setSupported(result !== null);
      setWorldbooks(result ?? []);
    } catch (reason) {
      setError(errorText(reason, '读取世界书失败，请稍后重试。'));
    } finally {
      setLoading(false);
    }
  }

  async function openBook(worldbookId: string) {
    setLoading(true);
    setError(null);
    try {
      const detail = await readWorldbook(worldbookId);
      setSelected(detail.worldbook);
      setEntries(detail.entries);
    } catch (reason) {
      setError(errorText(reason, '读取世界书条目失败。'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setEntries([]);
    setAdding(false);
    setNewName('');
    void reloadBooks();
  }, [open]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (selected) await openBook(selected.worldbook_id);
      else await reloadBooks();
    } catch (reason) {
      setError(errorText(reason, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  if (selected) {
    return (
      <PanelShell
        title={selected.name}
        onClose={onClose}
        onBack={() => {
          setSelected(null);
          setAdding(false);
          void reloadBooks();
        }}
      >
        <p className="persona-lead">
          只有命中关键词的条目和常驻条目会进入对话，其余条目留在这里不占用上下文。
        </p>
        {loading ? (
          <p className="import-state">
            <LoaderCircle className="spin" size={18} /> 正在读取条目…
          </p>
        ) : (
          <>
            {entries.length === 0 && !adding && (
              <p className="persona-empty">这本世界书还没有条目。</p>
            )}
            <ul className="worldbook-entries">
              {entries.map((entry) => (
                <li key={entry.entry_id} className={entry.enabled ? '' : 'is-disabled'}>
                  <div className="worldbook-entry-head">
                    <strong>{entry.title || '未命名条目'}</strong>
                    <span className="worldbook-tags">
                      {entry.constant ? (
                        <em className="persona-badge">常驻</em>
                      ) : (
                        entry.keys.map((key) => <em key={key}>{key}</em>)
                      )}
                    </span>
                  </div>
                  <p>{entry.content}</p>
                  <div className="persona-item-actions">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={entry.enabled ? `停用条目 ${entry.title || '未命名条目'}` : `启用条目 ${entry.title || '未命名条目'}`}
                      onClick={() =>
                        void run(
                          () => updateWorldbookEntry(entry.entry_id, { enabled: !entry.enabled }),
                          '切换条目状态失败。'
                        )
                      }
                    >
                      {entry.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="persona-delete"
                      disabled={busy}
                      aria-label={`删除条目 ${entry.title || '未命名条目'}`}
                      onClick={() => {
                        if (!window.confirm('删除这条世界知识？')) return;
                        void run(() => deleteWorldbookEntry(entry.entry_id), '删除条目失败。');
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {adding ? (
              <EntryEditor
                busy={busy}
                onCancel={() => setAdding(false)}
                onSubmit={(draft) => {
                  setAdding(false);
                  void run(
                    () => createWorldbookEntry(selected.worldbook_id, draft),
                    '添加条目失败。'
                  );
                }}
              />
            ) : (
              <button type="button" className="secondary-button persona-add" onClick={() => setAdding(true)}>
                <Plus size={16} /> 新增条目
              </button>
            )}
          </>
        )}
        {error && <p className="inline-error">{error}</p>}
      </PanelShell>
    );
  }

  return (
    <PanelShell title="世界书" onClose={onClose}>
      <p className="persona-lead">
        世界书保存长期不变的世界设定。它按关键词命中注入，和「共同回忆」不同——回忆记录你和角色一起经历过的事。
      </p>
      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> 正在读取世界书…
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{UNAVAILABLE}</p>}
      {!loading && supported && (
        <>
          {worldbooks.length === 0 && (
            <p className="persona-empty">
              还没有世界书。导入带 Character Book 的角色卡时也会自动生成一本。
            </p>
          )}
          <ul className="persona-list">
            {worldbooks.map((book) => (
              <li key={book.worldbook_id}>
                <button
                  type="button"
                  className="persona-item"
                  onClick={() => void openBook(book.worldbook_id)}
                  aria-label={`打开世界书 ${book.name}`}
                >
                  <span className="persona-avatar"><BookOpen size={19} /></span>
                  <span className="persona-copy">
                    <strong>
                      {book.name}
                      {book.origin === 'CHARACTER_BOOK' && <em className="persona-badge">角色卡自带</em>}
                      {!book.enabled && <em className="persona-badge">已停用</em>}
                    </strong>
                    <small>{book.entry_count} 条设定</small>
                  </span>
                </button>
                <div className="persona-item-actions">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={book.enabled ? `停用世界书 ${book.name}` : `启用世界书 ${book.name}`}
                    onClick={() =>
                      void run(
                        () => updateWorldbook(book.worldbook_id, { enabled: !book.enabled }),
                        '切换世界书状态失败。'
                      )
                    }
                  >
                    {book.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="persona-delete"
                    disabled={busy}
                    aria-label={`删除世界书 ${book.name}`}
                    onClick={() => {
                      if (!window.confirm(`删除世界书「${book.name}」？关联的角色会失去这些设定。`)) return;
                      void run(() => deleteWorldbook(book.worldbook_id), '删除世界书失败。');
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="editor-section worldbook-form">
            <label>
              新建世界书
              <input
                aria-label="世界书名称"
                value={newName}
                maxLength={200}
                placeholder="例如：白港设定集"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !newName.trim()}
              onClick={() => {
                const name = newName.trim();
                setNewName('');
                void run(() => createWorldbook(name), '创建世界书失败。');
              }}
            >
              <Plus size={17} /> 创建
            </button>
          </div>
        </>
      )}
      {error && <p className="inline-error">{error}</p>}
    </PanelShell>
  );
}

/** Choose which worldbooks back one character. One book may back many characters. */
export function CharacterWorldbookPanel({
  open,
  characterId,
  characterName,
  onClose
}: {
  open: boolean;
  characterId: string | null;
  characterName: string;
  onClose: () => void;
}) {
  const [worldbooks, setWorldbooks] = useState<Worldbook[]>([]);
  const [linked, setLinked] = useState<CharacterWorldbookLink[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !characterId) return;
    setLoading(true);
    setError(null);
    void Promise.all([listWorldbooks(), listCharacterWorldbooks(characterId)])
      .then(([books, links]) => {
        setSupported(books !== null && links !== null);
        setWorldbooks(books ?? []);
        setLinked(links ?? []);
      })
      .catch((reason: unknown) => setError(errorText(reason, '读取世界书失败。')))
      .finally(() => setLoading(false));
  }, [open, characterId]);

  async function toggle(worldbookId: string) {
    if (!characterId) return;
    const next = linked.some((link) => link.worldbook_id === worldbookId)
      ? linked.filter((link) => link.worldbook_id !== worldbookId)
      : [...linked, { worldbook_id: worldbookId }];
    setBusy(true);
    setError(null);
    try {
      const result = await setCharacterWorldbooks(
        characterId,
        next.map((link) => ({ worldbook_id: link.worldbook_id }))
      );
      setLinked(result);
    } catch (reason) {
      setError(errorText(reason, '保存关联失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <PanelShell title={`${characterName}的世界书`} onClose={onClose}>
      <p className="persona-lead">
        勾选的世界书会在与该角色对话时参与匹配。同一本世界书可以同时关联多个角色。
      </p>
      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> 正在读取世界书…
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{UNAVAILABLE}</p>}
      {!loading && supported && worldbooks.length === 0 && (
        <p className="persona-empty">还没有世界书，可以先在「设置 → 世界书」中创建。</p>
      )}
      {!loading && supported && (
        <ul className="persona-list persona-choice-list">
          {worldbooks.map((book) => {
            const isLinked = linked.some((link) => link.worldbook_id === book.worldbook_id);
            return (
              <li key={book.worldbook_id}>
                <button
                  type="button"
                  className={`persona-item ${isLinked ? 'selected' : ''}`}
                  disabled={busy}
                  aria-pressed={isLinked}
                  onClick={() => void toggle(book.worldbook_id)}
                >
                  <span className="persona-avatar"><BookOpen size={19} /></span>
                  <span className="persona-copy">
                    <strong>{book.name}</strong>
                    <small>{book.entry_count} 条设定</small>
                  </span>
                  {isLinked && <Check size={17} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="inline-error">{error}</p>}
    </PanelShell>
  );
}
