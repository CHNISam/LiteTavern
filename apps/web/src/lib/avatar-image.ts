export const AVATAR_IMAGE_POLICY = {
  acceptedTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxInputBytes: 12 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  outputSize: 512,
  outputType: 'image/webp',
  outputQuality: 0.86
} as const;

export interface AvatarCrop {
  zoom: number;
  x: number;
  y: number;
}

export interface SquareCropGeometry {
  sx: number;
  sy: number;
  size: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculateSquareCrop(
  width: number,
  height: number,
  crop: AvatarCrop
): SquareCropGeometry {
  const zoom = clamp(crop.zoom, 1, 3);
  const size = Math.min(width, height) / zoom;
  const availableX = width - size;
  const availableY = height - size;
  return {
    sx: Math.round((availableX / 2) * (clamp(crop.x, -1, 1) + 1)),
    sy: Math.round((availableY / 2) * (clamp(crop.y, -1, 1) + 1)),
    size: Math.round(size)
  };
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('浏览器无法生成裁剪后的头像。'));
    }, type, quality);
  });
}

export async function processAvatarImage(
  file: File | Blob,
  crop: AvatarCrop = { zoom: 1, x: 0, y: 0 }
): Promise<Blob> {
  if (file.size > AVATAR_IMAGE_POLICY.maxInputBytes) {
    throw new Error('图片不能超过 12 MB。');
  }
  if (
    file.type
    && !AVATAR_IMAGE_POLICY.acceptedTypes.includes(
      file.type as typeof AVATAR_IMAGE_POLICY.acceptedTypes[number]
    )
  ) {
    throw new Error('请选择 JPEG、PNG 或 WebP 图片。');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法解析这张图片，请换一张有效的 JPEG、PNG 或 WebP 图片。');
  }

  try {
    const geometry = calculateSquareCrop(bitmap.width, bitmap.height, crop);
    const attempts = [
      { size: AVATAR_IMAGE_POLICY.outputSize, quality: AVATAR_IMAGE_POLICY.outputQuality },
      { size: 448, quality: 0.78 },
      { size: 384, quality: 0.7 }
    ];
    for (const attempt of attempts) {
      const canvas = document.createElement('canvas');
      canvas.width = attempt.size;
      canvas.height = attempt.size;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器不支持头像裁剪。');
      context.drawImage(
        bitmap,
        geometry.sx,
        geometry.sy,
        geometry.size,
        geometry.size,
        0,
        0,
        attempt.size,
        attempt.size
      );
      const blob = await canvasBlob(
        canvas,
        AVATAR_IMAGE_POLICY.outputType,
        attempt.quality
      );
      if (blob.size <= AVATAR_IMAGE_POLICY.maxOutputBytes) return blob;
    }
    throw new Error('裁剪后的头像仍然过大，请选择尺寸更小的图片。');
  } finally {
    bitmap.close();
  }
}
