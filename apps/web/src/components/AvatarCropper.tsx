import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject
} from 'react';
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import { processAvatarImage, type AvatarCrop } from '../lib/avatar-image';

interface AvatarCropperProps {
  existingUrl?: string;
  onChange: (avatar: Blob | null, removed: boolean) => void;
}

const DEFAULT_CROP: AvatarCrop = { zoom: 1, x: 0, y: 0 };

export function AvatarCropper({ existingUrl, onChange }: AvatarCropperProps) {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState(DEFAULT_CROP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  function replaceObjectUrl(
    next: string,
    current: MutableRefObject<string | null>,
    setter: (value: string | null) => void
  ) {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setter(next);
  }

  async function apply(nextFile = file, nextCrop = crop) {
    if (!nextFile || busy) return;
    setBusy(true);
    setError(null);
    try {
      const output = await processAvatarImage(nextFile, nextCrop);
      replaceObjectUrl(URL.createObjectURL(output), previewUrlRef, setPreviewUrl);
      onChange(output, false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '头像处理失败。');
    } finally {
      setBusy(false);
    }
  }

  async function choose(next: File | null) {
    if (!next || busy) return;
    setFile(next);
    setCrop(DEFAULT_CROP);
    replaceObjectUrl(URL.createObjectURL(next), sourceUrlRef, setSourceUrl);
    await apply(next, DEFAULT_CROP);
  }

  function firstImage(files: FileList | null): File | null {
    return Array.from(files ?? []).find((item) => item.type.startsWith('image/')) ?? null;
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void choose(firstImage(event.dataTransfer.files));
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    const image = Array.from(event.clipboardData.files)
      .find((item) => item.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      void choose(image);
    }
  }

  function remove() {
    setFile(null);
    setSourceUrl(null);
    setPreviewUrl(null);
    setError(null);
    onChange(null, true);
  }

  const displayed = previewUrl ?? existingUrl;
  return (
    <div
      className="avatar-cropper"
      data-testid="avatar-cropper"
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      onPaste={paste}
      tabIndex={0}
    >
      <div className="avatar-workbench">
        <div className="avatar-final-preview">
          {displayed
            ? <img src={displayed} alt="头像预览" />
            : <span><ImagePlus size={24} /><small>默认头像</small></span>}
        </div>
        <div className="avatar-controls">
          <label className="avatar-file-button">
            <ImagePlus size={16} />
            <span>{displayed ? '替换头像' : '选择头像'}</span>
            <input
              aria-label="选择头像"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void choose(event.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>
          {displayed && (
            <button type="button" className="avatar-remove" onClick={remove} disabled={busy}>
              <Trash2 size={15} /> 删除头像
            </button>
          )}
          <small>可拖入或粘贴图片；保存前会裁剪并缩放为正方形。</small>
        </div>
      </div>

      {sourceUrl && (
        <div className="crop-editor">
          <div className="crop-square">
            <img
              src={sourceUrl}
              alt=""
              style={{
                transform: `translate(${crop.x * -18}%, ${crop.y * -18}%) scale(${crop.zoom})`
              }}
            />
          </div>
          <div className="crop-sliders">
            <label>缩放<input type="range" min="1" max="3" step="0.05" value={crop.zoom} onChange={(event) => setCrop({ ...crop, zoom: Number(event.target.value) })} /></label>
            <label>水平<input type="range" min="-1" max="1" step="0.02" value={crop.x} onChange={(event) => setCrop({ ...crop, x: Number(event.target.value) })} /></label>
            <label>垂直<input type="range" min="-1" max="1" step="0.02" value={crop.y} onChange={(event) => setCrop({ ...crop, y: Number(event.target.value) })} /></label>
            <button type="button" onClick={() => void apply()} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={15} /> : null}
              更新裁剪预览
            </button>
          </div>
        </div>
      )}
      {error && <p className="inline-error">{error}</p>}
      <p className="avatar-hint">没有合适的头像？你可以使用任意图片工具制作后上传。</p>
    </div>
  );
}
