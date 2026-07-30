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
import { t } from '../lib/i18n';

const unavailable = () =>
  t().worldbook.unsupported;

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
                <ArrowLeft size={16} /> {t().worldbook.backToList}
              </button>
            )}
            <span className="eyebrow">Worldbook</span>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t().common.close}>
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
      <h3>{t().worldbook.addEntry}</h3>
      <label>
        {t().worldbook.entryTitleLabel}
        <input
          aria-label={t().worldbook.entryTitleAria}
          value={draft.title}
          maxLength={200}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </label>
      <label>
        {t().worldbook.entryContentLabel}
        <textarea
          aria-label={t().worldbook.entryContentAria}
          value={draft.content}
          rows={4}
          maxLength={20000}
          placeholder={t().worldbook.entryContentPlaceholder}
          onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
        />
      </label>
      <label>
        {t().worldbook.keywordsLabel}
        <input
          aria-label={t().worldbook.keywordsAria}
          value={keyText}
          disabled={draft.constant}
          placeholder={t().worldbook.keywordsPlaceholder}
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
        {t().worldbook.alwaysOn}
      </label>
      <label>
        {t().worldbook.positionLabel}
        <select
          aria-label={t().worldbook.positionAria}
          value={draft.position}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              position: event.target.value as WorldbookPosition
            }))
          }
        >
          <option value="BEFORE_CHAR">{t().worldbook.positionBeforeChar}</option>
          <option value="AFTER_CHAR">{t().worldbook.positionAfterChar}</option>
        </select>
      </label>
      <label>
        {t().worldbook.orderLabel}
        <input
          aria-label={t().worldbook.orderAria}
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
        <button type="button" className="secondary-button" onClick={onCancel}>{t().common.cancel}</button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !draft.content.trim()}
          onClick={() => onSubmit({ ...draft, keys: parseKeys(keyText) })}
        >
          {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
          {t().worldbook.addEntryAction}
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
      setError(errorText(reason, t().worldbook.readFailed));
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
      setError(errorText(reason, t().worldbook.readEntriesFailed));
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
          {t().worldbook.entriesLead}
        </p>
        {loading ? (
          <p className="import-state">
            <LoaderCircle className="spin" size={18} /> {t().worldbook.loadingEntries}
          </p>
        ) : (
          <>
            {entries.length === 0 && !adding && (
              <p className="persona-empty">{t().worldbook.emptyEntries}</p>
            )}
            <ul className="worldbook-entries">
              {entries.map((entry) => (
                <li key={entry.entry_id} className={entry.enabled ? '' : 'is-disabled'}>
                  <div className="worldbook-entry-head">
                    <strong>{entry.title || t().worldbook.untitledEntry}</strong>
                    <span className="worldbook-tags">
                      {entry.constant ? (
                        <em className="persona-badge">{t().worldbook.alwaysOnBadge}</em>
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
                      aria-label={entry.enabled
                        ? t().worldbook.disableEntryAria(entry.title || t().worldbook.untitledEntry)
                        : t().worldbook.enableEntryAria(entry.title || t().worldbook.untitledEntry)}
                      onClick={() =>
                        void run(
                          () => updateWorldbookEntry(entry.entry_id, { enabled: !entry.enabled }),
                          t().worldbook.toggleEntryFailed
                        )
                      }
                    >
                      {entry.enabled ? t().worldbook.disable : t().worldbook.enable}
                    </button>
                    <button
                      type="button"
                      className="persona-delete"
                      disabled={busy}
                      aria-label={t().worldbook.deleteEntryAria(entry.title || t().worldbook.untitledEntry)}
                      onClick={() => {
                        if (!window.confirm(t().worldbook.deleteEntryConfirm)) return;
                        void run(() => deleteWorldbookEntry(entry.entry_id), t().worldbook.deleteEntryFailed);
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
                    t().worldbook.addEntryFailed
                  );
                }}
              />
            ) : (
              <button type="button" className="secondary-button persona-add" onClick={() => setAdding(true)}>
                <Plus size={16} /> {t().worldbook.addEntry}
              </button>
            )}
          </>
        )}
        {error && <p className="inline-error">{error}</p>}
      </PanelShell>
    );
  }

  return (
    <PanelShell title={t().worldbook.panelTitle} onClose={onClose}>
      <p className="persona-lead">
        {t().worldbook.lead}
      </p>
      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> {t().worldbook.loadingBooks}
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{unavailable()}</p>}
      {!loading && supported && (
        <>
          {worldbooks.length === 0 && (
            <p className="persona-empty">
              {t().worldbook.emptyBooks}
            </p>
          )}
          <ul className="persona-list">
            {worldbooks.map((book) => (
              <li key={book.worldbook_id}>
                <button
                  type="button"
                  className="persona-item"
                  onClick={() => void openBook(book.worldbook_id)}
                  aria-label={t().worldbook.openAria(book.name)}
                >
                  <span className="persona-avatar"><BookOpen size={19} /></span>
                  <span className="persona-copy">
                    <strong>
                      {book.name}
                      {book.origin === 'CHARACTER_BOOK' && <em className="persona-badge">{t().worldbook.fromCard}</em>}
                      {!book.enabled && <em className="persona-badge">{t().worldbook.disabledBadge}</em>}
                    </strong>
                    <small>{t().worldbook.entryCount(book.entry_count)}</small>
                  </span>
                </button>
                <div className="persona-item-actions">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={book.enabled
                      ? t().worldbook.disableAria(book.name)
                      : t().worldbook.enableAria(book.name)}
                    onClick={() =>
                      void run(
                        () => updateWorldbook(book.worldbook_id, { enabled: !book.enabled }),
                        t().worldbook.toggleFailed
                      )
                    }
                  >
                    {book.enabled ? t().worldbook.disable : t().worldbook.enable}
                  </button>
                  <button
                    type="button"
                    className="persona-delete"
                    disabled={busy}
                    aria-label={t().worldbook.deleteAria(book.name)}
                    onClick={() => {
                      if (!window.confirm(t().worldbook.deleteConfirm(book.name))) return;
                      void run(() => deleteWorldbook(book.worldbook_id), t().worldbook.deleteFailed);
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
              {t().worldbook.createTitle}
              <input
                aria-label={t().worldbook.nameAria}
                value={newName}
                maxLength={200}
                placeholder={t().worldbook.namePlaceholder}
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
                void run(() => createWorldbook(name), t().worldbook.createFailed);
              }}
            >
              <Plus size={17} /> {t().worldbook.create}
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
      .catch((reason: unknown) => setError(errorText(reason, t().worldbook.readFailedShort)))
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
      setError(errorText(reason, t().worldbook.linkFailed));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <PanelShell title={t().worldbook.linkTitle(characterName)} onClose={onClose}>
      <p className="persona-lead">
        {t().worldbook.linkLead}
      </p>
      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> {t().worldbook.loadingBooks}
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{unavailable()}</p>}
      {!loading && supported && worldbooks.length === 0 && (
        <p className="persona-empty">{t().worldbook.linkEmpty}</p>
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
                    <small>{t().worldbook.entryCount(book.entry_count)}</small>
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
