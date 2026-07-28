import { useEffect, useRef, useState } from 'react';
import { Check, FileJson, LoaderCircle, Upload, X } from 'lucide-react';
import { processAvatarImage } from '../lib/avatar-image';

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
    const response = await fetch(path, { method: 'POST', credentials: 'include', body });
    const payload = await response.json() as Preview & {
      character_id?: string;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(payload.error?.message ?? '角色卡处理失败。');
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
      const response = await fetch('/v1/characters/import/preview', { method: 'POST', credentials: 'include', body });
      const payload = await response.json() as Preview & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? '角色卡解析失败。');
      setPreview(payload);
      if (next.type === 'image/png' || next.name.toLowerCase().endsWith('.png')) {
        try {
          const processed = await processAvatarImage(next);
          const url = URL.createObjectURL(processed);
          avatarPreviewRef.current = url;
          setAvatarPreview(url);
          setAvatar(processed);
        } catch {
          setAvatarWarning('角色设定可以导入，但卡片头像无法读取，将使用默认占位头像。');
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '角色卡解析失败。'); }
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
        await fetch(`/v1/characters/${imported.character_id}/avatar`, {
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
    catch (reason) { setError(reason instanceof Error ? reason.message : '角色卡导入失败。'); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  const compatibilityLabel = preview?.compatibility.level === 'FORMAL'
    ? '正式支持'
    : preview?.compatibility.level === 'COMPATIBLE' ? '兼容支持' : '仅保留数据';
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="settings-panel import-panel" role="dialog" aria-modal="true" aria-label="导入角色卡" onMouseDown={(event) => event.stopPropagation()}><header className="settings-header"><div><span className="eyebrow">角色设置</span><h2>{replaceCharacterId ? '更新角色卡' : '导入角色卡'}</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></header><div className="import-content"><label className="drop-zone"><input aria-label="选择角色卡文件" type="file" accept=".json,.png,application/json,image/png" onChange={(event) => void inspect(event.target.files?.[0] ?? null)} /><Upload size={24} /><strong>{file?.name ?? '选择 JSON 或 PNG 角色卡'}</strong><span>正式支持 Character Card V2 / V3，兼容 Tavern Card V1，最大 10 MB</span></label>{busy && <p className="import-state"><LoaderCircle className="spin" size={18} /> 正在安全解析…</p>}{error && <p className="inline-error">{error}</p>}{preview && <div className="card-preview"><div className="preview-avatar">{avatarPreview ? <img src={avatarPreview} alt="角色卡头像预览" /> : preview.character.name.slice(0, 1)}</div><div><small><FileJson size={13} /> {preview.format} · {compatibilityLabel}</small><h3>{preview.character.name}</h3><p>{preview.character.description || '暂无简介'}</p><dl><dt>性格</dt><dd>{preview.character.personality || '未填写'}</dd><dt>开场</dt><dd>{preview.character.firstMessage}</dd></dl></div>{avatarWarning && <p className="provider-notice">{avatarWarning}</p>}{preview.compatibility.unapplied_fields.length > 0 && <p className="provider-notice">未生效但会保留：{preview.compatibility.unapplied_fields.join('、')}</p>}{preview.warnings.map((warning) => <p className="provider-notice" key={warning}>{warning}</p>)}</div>}{preview && <button className="primary-button" disabled={busy} onClick={() => void confirm()}><Check size={17} /> 确认{replaceCharacterId ? '更新' : '导入'}</button>}<p className="privacy-footnote">角色卡按不可信文件处理：LiteTavern 不执行其中的脚本，也不会自动访问卡片内的远程地址。</p></div></section></div>;
}
