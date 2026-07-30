import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject,
  type PointerEvent
} from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import {
  AVATAR_IMAGE_POLICY,
  calculateSquareCrop,
  processAvatarImage,
  type AvatarCrop
} from '../lib/avatar-image';
import { useT } from '../lib/i18n';

/**
 * What the cropper hands back. The viewport is already exact, so nothing is
 * encoded while the user adjusts — the caller encodes once, when it saves.
 * Handing back a finished Blob instead meant a save that landed before the
 * encode finished silently dropped the avatar.
 */
export interface AvatarSelection {
  encode: () => Promise<Blob>;
}

interface AvatarCropperProps {
  existingUrl?: string;
  onChange: (selection: AvatarSelection | null, removed: boolean) => void;
}

const DEFAULT_CROP: AvatarCrop = { zoom: 1, x: 0, y: 0 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Places the source image inside the crop viewport so that what the viewport
 * shows is exactly what `processAvatarImage` will cut. Same geometry as
 * `calculateSquareCrop`, expressed in viewport pixels.
 */
function viewportImageStyle(
  natural: { width: number; height: number } | null,
  crop: AvatarCrop,
  viewport: number
) {
  if (!natural || !viewport) return undefined;
  const { sx, sy, size } = calculateSquareCrop(natural.width, natural.height, crop);
  const scale = viewport / size;
  return {
    width: `${natural.width * scale}px`,
    height: `${natural.height * scale}px`,
    transform: `translate(${-sx * scale}px, ${-sy * scale}px)`
  };
}

export function AvatarCropper({ existingUrl, onChange }: AvatarCropperProps) {
  const t = useT();
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState(DEFAULT_CROP);
  const [error, setError] = useState<string | null>(null);
  // Measured, not assumed: the drag maths and the preview geometry both need the
  // viewport's real width, and it is responsive.
  const [viewport, setViewport] = useState(0);
  const sourceUrlRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const cropRef = useRef(crop);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; crop: AvatarCrop } | null>(null);

  // The encoder reads the crop through a ref, so the selection handed to the
  // caller stays valid however many times the user nudges the frame afterwards.
  useEffect(() => { cropRef.current = crop; }, [crop]);

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setViewport(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function replaceSourceUrl(
    next: string | null,
    current: MutableRefObject<string | null>,
    setter: (value: string | null) => void
  ) {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setter(next);
  }

  /** Obvious rejections are reported at pick time rather than at save time. */
  function rejectionFor(candidate: File): string | null {
    if (candidate.size > AVATAR_IMAGE_POLICY.maxInputBytes) return t.avatar.tooLarge;
    if (
      candidate.type &&
      !AVATAR_IMAGE_POLICY.acceptedTypes.includes(
        candidate.type as (typeof AVATAR_IMAGE_POLICY.acceptedTypes)[number]
      )
    ) {
      return t.avatar.wrongType;
    }
    return null;
  }

  function choose(next: File | null) {
    if (!next) return;
    const rejection = rejectionFor(next);
    if (rejection) {
      setError(rejection);
      return;
    }
    setNatural(null);
    setCrop(DEFAULT_CROP);
    cropRef.current = DEFAULT_CROP;
    setError(null);
    replaceSourceUrl(URL.createObjectURL(next), sourceUrlRef, setSourceUrl);
    onChange({ encode: () => processAvatarImage(next, cropRef.current) }, false);
  }

  function firstImage(files: FileList | null): File | null {
    return Array.from(files ?? []).find((item) => item.type.startsWith('image/')) ?? null;
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    choose(firstImage(event.dataTransfer.files));
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    const image = Array.from(event.clipboardData.files).find((item) =>
      item.type.startsWith('image/')
    );
    if (image) {
      event.preventDefault();
      choose(image);
    }
  }

  function remove() {
    setNatural(null);
    setCrop(DEFAULT_CROP);
    setError(null);
    replaceSourceUrl(null, sourceUrlRef, setSourceUrl);
    onChange(null, true);
  }

  // Dragging the picture is how repositioning works everywhere else, so the two
  // separate 水平/垂直 sliders are gone. Pointer capture keeps the drag alive when
  // the pointer leaves the small viewport.
  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!natural || !sourceUrl) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, crop };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !natural || !viewport) return;
    const { size } = calculateSquareCrop(natural.width, natural.height, drag.crop);
    const scale = viewport / size;
    const spanX = natural.width - size;
    const spanY = natural.height - size;
    // Pixels dragged convert back into the -1..1 crop offsets the encoder takes.
    const nextX = spanX > 0 ? drag.crop.x - (2 * (event.clientX - drag.x)) / (spanX * scale) : 0;
    const nextY = spanY > 0 ? drag.crop.y - (2 * (event.clientY - drag.y)) / (spanY * scale) : 0;
    setCrop({ zoom: drag.crop.zoom, x: clamp(nextX, -1, 1), y: clamp(nextY, -1, 1) });
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const displayed = sourceUrl ?? existingUrl;
  const adjustable = Boolean(sourceUrl && natural);

  return (
    <div
      className="avatar-cropper"
      data-testid="avatar-cropper"
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      onPaste={paste}
    >
      <div className="avatar-workbench">
        {/* One picture, not two: this viewport is both the crop surface and the
            preview, so the frame the user drags is the frame that gets saved. */}
        <div
          ref={viewportRef}
          className={`avatar-viewport ${adjustable ? 'is-adjustable' : ''}`}
          data-testid="avatar-viewport"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {displayed ? (
            <img
              src={displayed}
              alt={t.avatar.preview}
              draggable={false}
              {...(sourceUrl ? { style: viewportImageStyle(natural, crop, viewport) } : {})}
              onLoad={(event) =>
                sourceUrl &&
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight
                })
              }
            />
          ) : (
            <span className="avatar-viewport-empty"><ImagePlus size={22} /></span>
          )}
        </div>

        <div className="avatar-controls">
          <div className="avatar-buttons">
            <label className="avatar-file-button">
              <ImagePlus size={15} />
              <span>{displayed ? t.avatar.replace : t.avatar.chooseShort}</span>
              <input
                aria-label={t.avatar.choose}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => choose(event.target.files?.[0] ?? null)}
              />
            </label>
            {displayed && (
              <button type="button" className="avatar-remove" onClick={remove} aria-label={t.avatar.remove}>
                <Trash2 size={15} />
              </button>
            )}
          </div>

          {adjustable ? (
            <label className="avatar-zoom">
              <span>{t.avatar.zoom}</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.02"
                aria-label={t.avatar.zoom}
                value={crop.zoom}
                onChange={(event) => setCrop({ ...crop, zoom: Number(event.target.value) })}
              />
            </label>
          ) : (
            <small>{t.avatar.dropHint}</small>
          )}
          {adjustable && <small>{t.avatar.dragHint}</small>}
        </div>
      </div>

      {error && <p className="inline-error">{error}</p>}
    </div>
  );
}
