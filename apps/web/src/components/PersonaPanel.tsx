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
import { t } from '../lib/i18n';

const unavailable = () =>
  t().persona.unsupported;

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
          <button className="icon-button" onClick={onClose} aria-label={t().common.close}>
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
      setError(errorText(reason, t().persona.readFailed));
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
      setError(t().persona.nameRequired);
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
      setError(errorText(reason, t().persona.saveFailed));
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
    <PanelShell title={t().persona.panelTitle} eyebrow={t().persona.eyebrow} onClose={onClose}>
      <p className="persona-lead">
        {t().persona.lead}
      </p>
      <p className="privacy-footnote">{t().persona.localOnly}</p>

      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> {t().persona.loading}
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{unavailable()}</p>}

      {!loading && supported && (
        <>
          {personas.length === 0 && editingId === null && (
            <p className="persona-empty">
              {t().persona.empty}
            </p>
          )}

          <ul className="persona-list">
            {personas.map((persona) => (
              <li key={persona.persona_id}>
                <button
                  type="button"
                  className="persona-item"
                  onClick={() => startEdit(persona)}
                  aria-label={t().persona.editAria(persona.name)}
                >
                  <span className="persona-avatar"><UserRound size={19} /></span>
                  <span className="persona-copy">
                    <strong>
                      {persona.name}
                      {persona.is_default && <em className="persona-badge">{t().persona.defaultBadge}</em>}
                    </strong>
                    <small>{persona.description || t().persona.noDescription}</small>
                    <small>
                      {persona.position}
                      {persona.position === 'AT_DEPTH'
                        ? ` · ${t().persona.runtimeAtDepth(
                            persona.depth ?? 2,
                            persona.role
                          )}`
                        : ''}
                      {persona.avatar_missing
                        ? ` · ${t().persona.avatarMissing}`
                        : ''}
                    </small>
                    {Object.keys(persona.source_fields ?? {}).length > 0 && (
                      <small>
                        {t().persona.preservedFields(
                          Object.keys(persona.source_fields ?? {}).length
                        )}
                      </small>
                    )}
                  </span>
                </button>
                <div className="persona-item-actions">
                  {!persona.is_default && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t().persona.setDefaultAria(persona.name)}
                      onClick={() =>
                        void run(
                          () => updatePersona(persona.persona_id, { is_default: true }),
                          t().persona.setDefaultFailed
                        )
                      }
                    >
                      <Star size={16} /> {t().persona.setDefault}
                    </button>
                  )}
                  <button
                    type="button"
                    className="persona-delete"
                    disabled={busy}
                    aria-label={t().persona.deleteAria(persona.name)}
                    onClick={() => {
                      if (!window.confirm(t().persona.deleteConfirm(persona.name))) return;
                      void run(() => deletePersona(persona.persona_id), t().persona.deleteFailed);
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
              <Plus size={16} /> {t().persona.create}
            </button>
          ) : (
            <div className="editor-section persona-form">
              <h3>{editingId === 'new' ? t().persona.createTitle : t().persona.editTitle}</h3>
              <label>
                {t().persona.nameLabel}
                <input
                  aria-label={t().persona.nameAria}
                  value={name}
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                {t().persona.descriptionLabel}
                <textarea
                  aria-label={t().persona.descriptionAria}
                  value={description}
                  rows={5}
                  maxLength={4000}
                  placeholder={t().persona.descriptionPlaceholder}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <div className="persona-form-actions">
                <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>
                  {t().common.cancel}
                </button>
                <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                  {t().persona.save}
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
      .catch((reason: unknown) => setError(errorText(reason, t().persona.readFailedShort)))
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
      setError(errorText(reason, t().persona.switchFailed));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <PanelShell title={t().persona.pickerTitle} eyebrow={t().persona.eyebrow} onClose={onClose}>
      <p className="persona-lead">
        {t().persona.pickerLead}
      </p>
      <p className="privacy-footnote">
        {t().persona.conversationLocalOnly}
      </p>
      {loading && (
        <p className="import-state">
          <LoaderCircle className="spin" size={18} /> {t().persona.loading}
        </p>
      )}
      {!loading && !supported && <p className="persona-empty">{unavailable()}</p>}
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
                <strong>{t().persona.none}</strong>
                <small>{t().persona.noneHint}</small>
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
                    {persona.is_default && <em className="persona-badge">{t().persona.defaultBadge}</em>}
                  </strong>
                  <small>{persona.description || t().persona.noDescription}</small>
                </span>
                {personaId === persona.persona_id && <Check size={17} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && supported && personas.length === 0 && (
        <p className="persona-empty">{t().persona.pickerEmpty}</p>
      )}
      {error && <p className="inline-error">{error}</p>}
    </PanelShell>
  );
}
