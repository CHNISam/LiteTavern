import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, X } from 'lucide-react';
import { api, readApiJson } from '../lib/api';
import {
  EMPTY_CHARACTER,
  fetchCharacterCard,
  type CardDetail,
  type CharacterModel
} from '../lib/character-card';
import { useT } from '../lib/i18n';
import { cloudUrl } from '../lib/runtime-config';
import { AvatarCropper, type AvatarSelection } from './AvatarCropper';

export function CharacterEditor({ open, characterId, onClose, onSaved }: {
  open: boolean;
  characterId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [model, setModel] = useState<CharacterModel>(EMPTY_CHARACTER);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [avatar, setAvatar] = useState<AvatarSelection | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    setAvatar(null);
    setAvatarRemoved(false);
    setCreatedId(null);
    setError(null);
    if (!characterId) {
      setModel(EMPTY_CHARACTER);
      setDetail(null);
      return;
    }
    setLoading(true);
    void fetchCharacterCard(characterId)
      .then((result) => {
        setModel(result.normalized_data);
        setDetail(result);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [open, characterId]);

  function field<K extends keyof CharacterModel>(key: K, value: CharacterModel[K]) {
    setModel((current) => ({ ...current, [key]: value }));
  }

  async function uploadAvatar(targetId: string): Promise<void> {
    if (avatar) {
      // Encoded here, once, from the crop as it stands at save time.
      const body = new FormData();
      body.append('file', await avatar.encode(), 'avatar.webp');
      const response = await fetch(cloudUrl(`/v1/characters/${targetId}/avatar`), {
        method: 'POST',
        credentials: 'include',
        body
      });
      const payload = await readApiJson<{ error?: { message?: string } }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? t.avatar.uploadFailed);
    } else if (avatarRemoved) {
      const response = await fetch(cloudUrl(`/v1/characters/${targetId}/avatar`), {
        method: 'DELETE',
        credentials: 'include'
      });
      const payload = await readApiJson<{ error?: { message?: string } }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? t.avatar.deleteFailed);
    }
  }

  async function save() {
    if (submitting.current) return;
    if (!model.name.trim()) {
      setError(t.editor.nameRequired);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    let targetId = characterId ?? createdId;
    try {
      if (targetId) {
        await api(`/v1/characters/${targetId}/card`, {
          method: 'PUT',
          body: JSON.stringify(model)
        });
      } else {
        const created = await api<{ character_id: string }>('/v1/characters', {
          method: 'POST',
          body: JSON.stringify(model)
        });
        targetId = created.character_id;
        setCreatedId(targetId);
      }
      try {
        await uploadAvatar(targetId);
      } catch (reason) {
        setError(
          t.editor.avatarUploadFailed(
            reason instanceof Error ? reason.message : t.editor.avatarUploadRetry
          )
        );
        return;
      }
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.editor.saveFailed);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="settings-panel character-editor-panel"
        role="dialog"
        aria-modal="true"
        aria-label={characterId ? t.editor.editTitle : t.editor.createTitle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="eyebrow">{t.editor.eyebrow}</span><h2>{characterId ? t.editor.editTitle : t.editor.createTitle}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}><X size={19} /></button>
        </header>
        {loading ? (
          <p className="import-state"><LoaderCircle className="spin" size={18} /> {t.editor.loading}</p>
        ) : (
          <div className="character-editor-content">
            {detail && (
              <section className="compatibility-summary">
                <div>
                  <span className={`compatibility-badge level-${detail.source_metadata.compatibility_level.toLowerCase()}`}>
                    {t.editor.compatibility[detail.source_metadata.compatibility_level]}
                  </span>
                  <small>{detail.source_metadata.format} · {detail.source_metadata.container}</small>
                </div>
                {detail.source_metadata.unapplied_fields.length > 0 && (
                  <details>
                    <summary>{t.editor.unappliedFields(detail.source_metadata.unapplied_fields.length)}</summary>
                    <ul>{detail.source_metadata.unapplied_fields.map((item) => <li key={item}>{item}</li>)}</ul>
                  </details>
                )}
                {detail.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              </section>
            )}

            {/* Identity first: the avatar and the name are one row, so the picker
                stops being a loose block floating between two text fields. */}
            <div className="editor-identity">
              <AvatarCropper
                {...(characterId
                  ? { existingUrl: cloudUrl(`/v1/characters/${characterId}/avatar`) }
                  : {})}
                onChange={(next, removed) => {
                  setAvatar(next);
                  setAvatarRemoved(removed);
                  setError(null);
                }}
              />
              <label className="editor-name">
                <span>{t.editor.name}</span>
                <input
                  aria-label={t.editor.name}
                  value={model.name}
                  maxLength={200}
                  placeholder={t.editor.namePlaceholder}
                  onChange={(event) => field('name', event.target.value)}
                />
              </label>
            </div>

            {/* Field tiers follow SillyTavern's: personality, scenario and example
                dialogue define the character and belong here. Only prompt overrides
                and authoring metadata are advanced — "核心性格" used to be buried
                in the advanced drawer with no way to tell it drove the profile. */}
            <div className="editor-section">
              <h3>{t.editor.sectionPerson}</h3>
              <label>
                <span>{t.editor.description}</span>
                <textarea value={model.description} rows={4} placeholder={t.editor.descriptionPlaceholder} onChange={(event) => field('description', event.target.value)} />
              </label>
              <label>
                <span>{t.editor.personality}<em>{t.editor.personalityNote}</em></span>
                <textarea value={model.personality} rows={3} placeholder={t.editor.personalityPlaceholder} onChange={(event) => field('personality', event.target.value)} />
              </label>
              <label>
                <span>{t.editor.scenario}</span>
                <textarea value={model.scenario} rows={3} placeholder={t.editor.scenarioPlaceholder} onChange={(event) => field('scenario', event.target.value)} />
              </label>
            </div>

            <div className="editor-section">
              <h3>{t.editor.sectionDialogue}</h3>
              <label>
                <span>{t.editor.firstMessage}</span>
                <textarea value={model.first_message} rows={3} onChange={(event) => field('first_message', event.target.value)} />
              </label>
              <label>
                <span>{t.editor.alternateGreetings}<em>{t.editor.alternateGreetingsNote}</em></span>
                <textarea value={model.alternate_greetings.join('\n')} rows={3} onChange={(event) => field('alternate_greetings', event.target.value.split('\n').filter(Boolean))} />
              </label>
              <label>
                <span>{t.editor.exampleMessages}</span>
                <textarea value={model.example_messages} rows={4} placeholder={t.editor.exampleMessagesPlaceholder} onChange={(event) => field('example_messages', event.target.value)} />
              </label>
            </div>

            <details className="advanced-editor">
              <summary>{t.editor.advanced}</summary>
              <div className="editor-section">
                <label><span>{t.editor.systemPrompt}</span><textarea value={model.system_prompt} rows={4} onChange={(event) => field('system_prompt', event.target.value)} /></label>
                <label><span>{t.editor.postHistory}</span><textarea value={model.post_history_instructions} rows={3} onChange={(event) => field('post_history_instructions', event.target.value)} /></label>
                <label><span>{t.editor.tags}<em>{t.editor.tagsNote}</em></span><input value={model.tags.join(', ')} onChange={(event) => field('tags', event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} /></label>
                <div className="creator-fields">
                  <label><span>{t.editor.creator}</span><input value={model.creator.name} onChange={(event) => setModel((current) => ({ ...current, creator: { ...current.creator, name: event.target.value } }))} /></label>
                  <label><span>{t.editor.characterVersion}</span><input value={model.creator.character_version} onChange={(event) => setModel((current) => ({ ...current, creator: { ...current.creator, character_version: event.target.value } }))} /></label>
                </div>
                <label><span>{t.editor.creatorNotes}</span><textarea value={model.creator.notes} rows={3} onChange={(event) => setModel((current) => ({ ...current, creator: { ...current.creator, notes: event.target.value } }))} /></label>
              </div>
            </details>
            {error && <p className="inline-error">{error}</p>}
            <button className="primary-button editor-save-button" disabled={busy} onClick={() => void save()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
              {t.editor.saveCharacter}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
