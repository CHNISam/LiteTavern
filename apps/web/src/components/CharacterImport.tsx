import { useEffect, useRef, useState } from 'react';
import { Check, FileJson, LoaderCircle, Upload, X } from 'lucide-react';
import { processAvatarImage } from '../lib/avatar-image';
import {
  embeddedRegexScripts,
  previewCardData,
  readCardFile,
  type LocalCardPreview
} from '../lib/card-file';
import { useT } from '../lib/i18n';
import { characterModelFromCard, saveLocalCharacter } from '../lib/character-card';
import { cloneJson } from '../lib/json-clone';
import { storeImportedCardExtensions } from '../lib/local-card-assets';
import {
  normalizeRegexScript,
  RegexPlacement
} from '../lib/regex-engine';

type Preview = LocalCardPreview;

export function CharacterImport({ open, replaceCharacterId, partition, onClose, onImported }: { open: boolean; replaceCharacterId?: string; partition: string; onClose: () => void; onImported: (characterId: string) => Promise<void> }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [cardData, setCardData] = useState<Record<string, unknown> | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [authorizeRegex, setAuthorizeRegex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<Blob | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarWarning, setAvatarWarning] = useState<string | null>(null);
  const avatarPreviewRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
  }, []);

  async function avatarDataUrl(blob: Blob | null): Promise<string | undefined> {
    if (!blob) return undefined;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function inspect(next: File | null) {
    setFile(next); setCardData(null); setPreview(null); setAuthorizeRegex(false);
    setError(null); setAvatar(null); setAvatarWarning(null);
    if (avatarPreviewRef.current) URL.revokeObjectURL(avatarPreviewRef.current);
    avatarPreviewRef.current = null;
    setAvatarPreview(null);
    if (!next) return;
    setBusy(true);
    try {
      const parsed = await readCardFile(next);
      const isPng =
        next.type === 'image/png' || next.name.toLowerCase().endsWith('.png');
      setCardData(parsed);
      setPreview(previewCardData(parsed, isPng));
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
    } catch {
      setError(t.importer.parseFailed);
    }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true); setError(null);
    try {
      if (!cardData || !preview) {
        throw new Error(t.importer.importFailed);
      }
      const nextAvatar = await avatarDataUrl(avatar);
      const characterId = await saveLocalCharacter({
        partition,
        ...(replaceCharacterId ? { characterId: replaceCharacterId } : {}),
        model: characterModelFromCard(cardData),
        ...(nextAvatar === undefined ? {} : { avatarDataUrl: nextAvatar }),
        detail: {
          normalized_data: characterModelFromCard(cardData),
          raw_data: cloneJson(cardData),
          source_metadata: {
            compatibility_level: preview.compatibility.level,
            format: preview.format,
            container: file?.name.toLowerCase().endsWith('.png') ? 'PNG' : 'JSON',
            unapplied_fields: preview.compatibility.unapplied_fields
          },
          warnings: preview.warnings
        }
      });
      await storeImportedCardExtensions(
        cardData,
        characterId,
        preview.character.name,
        authorizeRegex
      );
      await onImported(characterId);
      onClose();
      setFile(null);
      setCardData(null);
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
  const regexScripts = embeddedRegexScripts(cardData).map((script) =>
    normalizeRegexScript(script, { trusted: false })
  );
  const placementLabel = (placement: RegexPlacement[]) =>
    [
      placement.includes(RegexPlacement.USER_INPUT) ? 'USER_INPUT' : '',
      placement.includes(RegexPlacement.AI_OUTPUT) ? 'AI_OUTPUT' : '',
      placement.includes(RegexPlacement.WORLD_INFO) ? 'WORLD_INFO' : ''
    ].filter(Boolean).join(' · ');
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="settings-panel import-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t.importer.importTitle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span className="eyebrow">{t.importer.eyebrow}</span>
            <h2>
              {replaceCharacterId
                ? t.importer.updateTitle
                : t.importer.importTitle}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="import-content">
          <label className="drop-zone">
            <input
              aria-label={t.importer.chooseFile}
              type="file"
              accept=".json,.png,application/json,image/png"
              onChange={(event) =>
                void inspect(event.target.files?.[0] ?? null)
              }
            />
            <Upload size={24} />
            <strong>{file?.name ?? t.importer.choosePlaceholder}</strong>
            <span>{t.importer.formatSupport}</span>
          </label>
          {busy && (
            <p className="import-state">
              <LoaderCircle className="spin" size={18} /> {t.importer.parsing}
            </p>
          )}
          {error && <p className="inline-error">{error}</p>}
          {preview && (
            <>
              <div className="card-preview">
                <div className="preview-avatar">
                  {avatarPreview ? (
                    <img src={avatarPreview} alt={t.importer.avatarPreview} />
                  ) : (
                    preview.character.name.slice(0, 1)
                  )}
                </div>
                <div>
                  <small>
                    <FileJson size={13} /> {preview.format} ·{' '}
                    {compatibilityLabel}
                  </small>
                  <h3>{preview.character.name}</h3>
                  <p>{preview.character.description || t.importer.noSummary}</p>
                  <dl>
                    <dt>{t.importer.personality}</dt>
                    <dd>
                      {preview.character.personality || t.importer.notFilled}
                    </dd>
                    <dt>{t.importer.opening}</dt>
                    <dd>{preview.character.firstMessage}</dd>
                  </dl>
                </div>
                {avatarWarning && (
                  <p className="provider-notice">{avatarWarning}</p>
                )}
                {preview.compatibility.unapplied_fields.length > 0 && (
                  <p className="provider-notice">
                    {t.importer.preserved(
                      preview.compatibility.unapplied_fields.join('、')
                    )}
                  </p>
                )}
              </div>
              <p className="privacy-footnote">
                {t.importer.localExtensionsOnly}
              </p>
              {regexScripts.length > 0 && (
                <div className="provider-notice">
                  <strong>
                    {t.importer.regexTitle(regexScripts.length)}
                  </strong>
                  <ul>
                    {regexScripts.map((script) => (
                      <li key={script.id}>
                        {script.scriptName} · {placementLabel(script.placement)}
                      </li>
                    ))}
                  </ul>
                  <label>
                    <input
                      type="checkbox"
                      checked={authorizeRegex}
                      onChange={(event) =>
                        setAuthorizeRegex(event.target.checked)
                      }
                    />{' '}
                    {t.importer.regexAuthorize}
                  </label>
                </div>
              )}
              {preview.warnings.map((warning) => (
                <p className="provider-notice" key={warning}>
                  {warning}
                </p>
              ))}
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void confirm()}
              >
                <Check size={17} />{' '}
                {replaceCharacterId
                  ? t.importer.confirmUpdate
                  : t.importer.confirmImport}
              </button>
            </>
          )}
          <p className="privacy-footnote">{t.importer.safetyNote}</p>
        </div>
      </section>
    </div>
  );
}
