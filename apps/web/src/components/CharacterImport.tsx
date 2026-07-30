import { useEffect, useRef, useState } from 'react';
import { Check, FileJson, LoaderCircle, Upload, X } from 'lucide-react';
import { readApiJson } from '../lib/api';
import { processAvatarImage } from '../lib/avatar-image';
import { useT } from '../lib/i18n';
import { cloudUrl } from '../lib/runtime-config';

interface Preview {
  format: string;
  character: {
    name: string;
    description: string;
    personality: string;
    firstMessage: string;
  };
  compatibility: {
    level: 'FORMAL' | 'COMPATIBLE' | 'PRESERVED';
    unapplied_fields: string[];
  };
  warnings: string[];
}

export function CharacterImport({ open, replaceCharacterId, onClose, onImported }: { open: boolean; replaceCharacterId?: string; onClose: () => void; onImported: () => Promise<void> }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<Blob | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarWarning, setAvatarWarning] = useState<string | null>(null);
  const avatarPreviewRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
  }, []);

  async function upload(path: string) {
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    if (replaceCharacterId) body.append('replace_character_id', replaceCharacterId);
    const response = await fetch(cloudUrl(path), {
      method: 'POST',
      credentials: 'include',
      body
    });
    const payload = await readApiJson<Preview & {
      character_id?: string;
      error?: { message?: string };
    }>(response);
    if (!response.ok) throw new Error(payload.error?.message ?? t.importer.processFailed);
    return payload;
  }

  async function inspect(next: File | null) {
    setFile(next); setPreview(null); setError(null); setAvatar(null); setAvatarWarning(null);
    if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
    avatarPreviewRef.current = null;
    setAvatarPreview(null);
    if (!next) return;
    setBusy(true);
    try {
      const body = new FormData(); body.append('file', next);
      const response = await fetch(cloudUrl('/v1/characters/import/preview'), {
        method: 'POST',
        credentials: 'include',
        body
      });
      const payload = await readApiJson<Preview & {
        error?: { message?: string };
      }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? t.importer.parseFailed);
      setPreview(payload);
      if (next.type === 'image/png' || next.name.toLowerCase().endsWith('.png')) {
        try {
          const processed = await processAvatarImage(next);
          const url = URL.createObjectURL(processed);
          avatarPreviewRef.current = url;
          setAvatarPreview(url);
          setAvatar(processed);
        } catch {
          setAvatarWarning(t.importer.avatarUnreadable);
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : t.importer.parseFailed); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const imported = await upload('/v1/characters/import');
      if (avatar && imported?.character_id) {
        const body = new FormData();
        body.append('file', avatar, 'avatar.webp');
        // Avatar failure is intentionally non-fatal: card data has already committed.
        await fetch(cloudUrl(`/v1/characters/${imported.character_id}/avatar`), {
          method: 'POST',
          credentials: 'include',
          body
        }).catch(() => undefined);
      }
      await onImported();
      onClose();
      setFile(null);
      setPreview(null);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : t.importer.importFailed); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  const compatibilityLabel = preview?.compatibility.level === 'FORMAL'
    ? t.editor.compatibility.FORMAL
    : preview?.compatibility.level === 'COMPATIBLE'
      ? t.editor.compatibility.COMPATIBLE
      : t.editor.compatibility.PRESERVED;
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="settings-panel import-panel" role="dialog" aria-modal="true" aria-label={t.importer.importTitle} onMouseDown={(event) => event.stopPropagation()}><header className="settings-header"><div><span className="eyebrow">{t.importer.eyebrow}</span><h2>{replaceCharacterId ? t.importer.updateTitle : t.importer.importTitle}</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></header><div className="import-content"><label className="drop-zone"><input aria-label={t.importer.chooseFile} type="file" accept=".json,.png,application/json,image/png" onChange={(event) => void inspect(event.target.files?.[0] ?? null)} /><Upload size={24} /><strong>{file?.name ?? t.importer.choosePlaceholder}</strong><span>{t.importer.formatSupport}</span></label>{busy && <p className="import-state"><LoaderCircle className="spin" size={18} /> {t.importer.parsing}</p>}{error && <p className="inline-error">{error}</p>}{preview && <div className="card-preview"><div className="preview-avatar">{avatarPreview ? <img src={avatarPreview} alt={t.importer.avatarPreview} /> : preview.character.name.slice(0, 1)}</div><div><small><FileJson size={13} /> {preview.format} · {compatibilityLabel}</small><h3>{preview.character.name}</h3><p>{preview.character.description || t.importer.noSummary}</p><dl><dt>{t.importer.personality}</dt><dd>{preview.character.personality || t.importer.notFilled}</dd><dt>{t.importer.opening}</dt><dd>{preview.character.firstMessage}</dd></dl></div>{avatarWarning && <p className="provider-notice">{avatarWarning}</p>}{preview.compatibility.unapplied_fields.length > 0 && <p className="provider-notice">{t.importer.preserved(preview.compatibility.unapplied_fields.join('、'))}</p>}{preview.warnings.map((warning) => <p className="provider-notice" key={warning}>{warning}</p>)}</div>}{preview && <button className="primary-button" disabled={busy} onClick={() => void confirm()}><Check size={17} /> {replaceCharacterId ? t.importer.confirmUpdate : t.importer.confirmImport}</button>}<p className="privacy-footnote">{t.importer.safetyNote}</p></div></section></div>;
}
