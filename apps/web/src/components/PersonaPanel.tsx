import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, Star, Trash2, UserRound, X } from 'lucide-react';
import {
  bindConversationPersona,
  createPersona,
  deletePersona,
  listPersonas,
  updatePersona,
  type Persona
} from '../lib/persona';

const UNAVAILABLE =
  '当前连接的服务还不支持用户身份，升级 LiteTavern Cloud 后即可使用。';

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function PanelShell({
  title,
  eyebrow,
  onClose,
  children
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel persona-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={19} />
          </button>
        </header>
        <div className="persona-content">{children}</div>
      </section>
    </div>
  );
}

/**
 * Manage the identities the user can speak as. Kept intentionally plain: a name, a
 * description and which one new conversations start with. Anything richer belongs in
 * the character editor, not here.
 */
export function PersonaPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const result = await listPersonas();
      setSupported(result !== null);
      setPersonas(result ?? []);
    } catch (reason) {
      setError(errorText(reason, '读取身份失败，请稍后重试。'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    setName('');
    setDescription('');
    void reload();
  }, [open]);

  function startCreate() {
    setEditingId('new');
    setName('');
    setDescription('');
    setError(null);
  }

  function startEdit(persona: Persona) {
    setEditingId(persona.persona_id);
    setName(persona.name);
    setDescription(persona.description);
    setError(null);
  }

  async function save() {
    if (!name.trim()) {
      setError('请填写身份名称。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId && editingId !== 'new') {
        await updatePersona(editingId, { name: name.trim(), description });
      } else {
        await createPersona({ name: name.trim(), description });
      }
      setEditingId(null);
      await reload();
    } catch (reason) {
      setError(errorText(reason, '保存身份失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(errorText(reason, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <PanelShell title="用户身份" eyebrow="Persona" onClose={onClose}>
      <p className="persona-lead">
        身份是你在故事里的样子：角色会怎样称呼你、把你当成谁。它与账号昵称、邮箱和套餐无关，
        只有身份会进入对话。
      </p>

      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> 正在读取身份…
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{UNAVAILABLE}</p>}

      {!loading && supported && (
        <>
          {personas.length === 0 && editingId === null && (
            <p className="persona-empty">
              还没有身份。新建一个之后，新的对话会自动使用它。
            </p>
          )}

          <ul className="persona-list">
            {personas.map((persona) => (
              <li key={persona.persona_id}>
                <button
                  type="button"
                  className="persona-item"
                  onClick={() => startEdit(persona)}
                  aria-label={`编辑身份 ${persona.name}`}
                >
                  <span className="persona-avatar"><UserRound size={19} /></span>
                  <span className="persona-copy">
                    <strong>
                      {persona.name}
                      {persona.is_default && <em className="persona-badge">默认</em>}
                    </strong>
                    <small>{persona.description || '还没有填写身份描述。'}</small>
                  </span>
                </button>
                <div className="persona-item-actions">
                  {!persona.is_default && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`把 ${persona.name} 设为默认身份`}
                      onClick={() =>
                        void run(
                          () => updatePersona(persona.persona_id, { is_default: true }),
                          '设置默认身份失败。'
                        )
                      }
                    >
                      <Star size={16} /> 设为默认
                    </button>
                  )}
                  <button
                    type="button"
                    className="persona-delete"
                    disabled={busy}
                    aria-label={`删除身份 ${persona.name}`}
                    onClick={() => {
                      if (!window.confirm(`删除身份「${persona.name}」？使用它的对话会回到未设置身份。`)) return;
                      void run(() => deletePersona(persona.persona_id), '删除身份失败。');
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {editingId === null ? (
            <button type="button" className="secondary-button persona-add" onClick={startCreate}>
              <Plus size={16} /> 新建身份
            </button>
          ) : (
            <div className="editor-section persona-form">
              <h3>{editingId === 'new' ? '新建身份' : '编辑身份'}</h3>
              <label>
                名称
                <input
                  aria-label="身份名称"
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                身份描述
                <textarea
                  aria-label="身份描述"
                  value={description}
                  rows={5}
                  maxLength={4000}
                  placeholder="外貌、性格、背景，或你希望角色怎样认识你。"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="persona-form-actions">
                <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>
                  取消
                </button>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                  保存身份
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <p className="inline-error">{error}</p>}
    </PanelShell>
  );
}

/**
 * Pick the identity one conversation runs as. Choosing here binds this conversation
 * only — the default persona keeps deciding what *new* conversations start with, so
 * an ongoing chat is never re-cast from somewhere else.
 */
export function ConversationPersonaPanel({
  open,
  conversationId,
  personaId,
  onClose,
  onBound
}: {
  open: boolean;
  conversationId: string | null;
  personaId: string | null;
  onClose: () => void;
  onBound: (personaId: string | null) => void;
}) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    void listPersonas()
      .then((result) => {
        setSupported(result !== null);
        setPersonas(result ?? []);
      })
      .catch((reason: unknown) => setError(errorText(reason, '读取身份失败。')))
      .finally(() => setLoading(false));
  }, [open]);

  async function choose(next: string | null) {
    if (!conversationId) return;
    setBusy(true);
    setError(null);
    try {
      await bindConversationPersona(conversationId, next);
      onBound(next);
      onClose();
    } catch (reason) {
      setError(errorText(reason, '切换身份失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <PanelShell title="本次对话的身份" eyebrow="Persona" onClose={onClose}>
      <p className="persona-lead">
        只影响当前这段对话。以后新建的对话仍然使用默认身份。
      </p>
      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> 正在读取身份…
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{UNAVAILABLE}</p>}
      {!loading && supported && (
        <ul className="persona-list persona-choice-list">
          <li>
            <button
              type="button"
              className={`persona-item ${personaId === null ? 'selected' : ''}`}
              disabled={busy}
              onClick={() => void choose(null)}
            >
              <span className="persona-avatar"><UserRound size={19} /></span>
              <span className="persona-copy">
                <strong>不使用身份</strong>
                <small>角色只会用一般称呼指代你。</small>
              </span>
              {personaId === null && <Check size={17} />}
            </button>
          </li>
          {personas.map((persona) => (
            <li key={persona.persona_id}>
              <button
                type="button"
                className={`persona-item ${personaId === persona.persona_id ? 'selected' : ''}`}
                disabled={busy}
                onClick={() => void choose(persona.persona_id)}
              >
                <span className="persona-avatar"><UserRound size={19} /></span>
                <span className="persona-copy">
                  <strong>
                    {persona.name}
                    {persona.is_default && <em className="persona-badge">默认</em>}
                  </strong>
                  <small>{persona.description || '还没有填写身份描述。'}</small>
                </span>
                {personaId === persona.persona_id && <Check size={17} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && supported && personas.length === 0 && (
        <p className="persona-empty">还没有身份，可以先在「设置 → 用户身份」中创建。</p>
      )}
      {error && <p className="inline-error">{error}</p>}
    </PanelShell>
  );
}
