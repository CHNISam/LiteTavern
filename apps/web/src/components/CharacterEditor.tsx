import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, X } from 'lucide-react';
import { api, readApiJson } from '../lib/api';
import {
  EMPTY_CHARACTER,
  fetchCharacterCard,
  type CardDetail,
  type CharacterModel
} from '../lib/character-card';
import { cloudUrl } from '../lib/runtime-config';
import { AvatarCropper, type AvatarSelection } from './AvatarCropper';

const COMPATIBILITY_LABEL = {
  FORMAL: '正式支持',
  COMPATIBLE: '兼容支持',
  PRESERVED: '仅保留数据'
} as const;

export function CharacterEditor({ open, characterId, onClose, onSaved }: {
  open: boolean;
  characterId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
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
      if (!response.ok) throw new Error(payload.error?.message ?? '头像上传失败。');
    } else if (avatarRemoved) {
      const response = await fetch(cloudUrl(`/v1/characters/${targetId}/avatar`), {
        method: 'DELETE',
        credentials: 'include'
      });
      const payload = await readApiJson<{ error?: { message?: string } }>(response);
      if (!response.ok) throw new Error(payload.error?.message ?? '头像删除失败。');
    }
  }

  async function save() {
    if (submitting.current) return;
    if (!model.name.trim()) {
      setError('请填写角色名称。');
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
          `角色资料已保存，但头像上传失败：${reason instanceof Error ? reason.message : '请重试。'}`
        );
        return;
      }
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '角色保存失败。');
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
        aria-label={characterId ? '编辑角色' : '创建角色'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="eyebrow">角色设定</span><h2>{characterId ? '编辑角色' : '创建角色'}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </header>
        {loading ? (
          <p className="import-state"><LoaderCircle className="spin" size={18} /> 正在读取角色设定…</p>
        ) : (
          <div className="character-editor-content">
            {detail && (
              <section className="compatibility-summary">
                <div>
                  <span className={`compatibility-badge level-${detail.source_metadata.compatibility_level.toLowerCase()}`}>
                    {COMPATIBILITY_LABEL[detail.source_metadata.compatibility_level]}
                  </span>
                  <small>{detail.source_metadata.format} · {detail.source_metadata.container}</small>
                </div>
                {detail.source_metadata.unapplied_fields.length > 0 && (
                  <details>
                    <summary>{detail.source_metadata.unapplied_fields.length} 项内容已保留但未生效</summary>
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
                <span>名称</span>
                <input
                  aria-label="名称"
                  value={model.name}
                  maxLength={200}
                  placeholder="角色叫什么"
                  onChange={(event) => field('name', event.target.value)}
                />
              </label>
            </div>

            {/* Field tiers follow SillyTavern's: personality, scenario and example
                dialogue define the character and belong here. Only prompt overrides
                and authoring metadata are advanced — "核心性格" used to be buried
                in the advanced drawer with no way to tell it drove the profile. */}
            <div className="editor-section">
              <h3>人物</h3>
              <label>
                <span>角色描述</span>
                <textarea value={model.description} rows={4} placeholder="外貌、身份、背景" onChange={(event) => field('description', event.target.value)} />
              </label>
              <label>
                <span>核心性格<em>显示在角色主页</em></span>
                <textarea value={model.personality} rows={3} placeholder="用顿号分隔可显示为标签，例如：温柔、坚定、话少" onChange={(event) => field('personality', event.target.value)} />
              </label>
              <label>
                <span>场景</span>
                <textarea value={model.scenario} rows={3} placeholder="你们相处的情境" onChange={(event) => field('scenario', event.target.value)} />
              </label>
            </div>

            <div className="editor-section">
              <h3>对话</h3>
              <label>
                <span>开场白</span>
                <textarea value={model.first_message} rows={3} onChange={(event) => field('first_message', event.target.value)} />
              </label>
              <label>
                <span>备选开场白<em>每行一条</em></span>
                <textarea value={model.alternate_greetings.join('\n')} rows={3} onChange={(event) => field('alternate_greetings', event.target.value.split('\n').filter(Boolean))} />
              </label>
              <label>
                <span>示例对话</span>
                <textarea value={model.example_messages} rows={4} placeholder="示范说话方式与语气" onChange={(event) => field('example_messages', event.target.value)} />
              </label>
            </div>

            <details className="advanced-editor">
              <summary>高级设定</summary>
              <div className="editor-section">
                <label><span>系统提示</span><textarea value={model.system_prompt} rows={4} onChange={(event) => field('system_prompt', event.target.value)} /></label>
                <label><span>后置提示</span><textarea value={model.post_history_instructions} rows={3} onChange={(event) => field('post_history_instructions', event.target.value)} /></label>
                <label><span>标签<em>逗号分隔</em></span><input value={model.tags.join(', ')} onChange={(event) => field('tags', event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} /></label>
                <div className="creator-fields">
                  <label><span>创作者</span><input value={model.creator.name} onChange={(event) => setModel((current) => ({ ...current, creator: { ...current.creator, name: event.target.value } }))} /></label>
                  <label><span>角色版本</span><input value={model.creator.character_version} onChange={(event) => setModel((current) => ({ ...current, creator: { ...current.creator, character_version: event.target.value } }))} /></label>
                </div>
                <label><span>创作者说明</span><textarea value={model.creator.notes} rows={3} onChange={(event) => setModel((current) => ({ ...current, creator: { ...current.creator, notes: event.target.value } }))} /></label>
              </div>
            </details>
            {error && <p className="inline-error">{error}</p>}
            <button className="primary-button editor-save-button" disabled={busy} onClick={() => void save()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
              保存角色
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
