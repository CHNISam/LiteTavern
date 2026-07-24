export const AVATAR_IMAGE_POLICY = {
  maxUploadBytes: 2 * 1024 * 1024,
  maxDimension: 1024,
  recommendedOutputSize: 512,
  acceptedMediaTypes: ['image/png', 'image/jpeg', 'image/webp']
} as const;

export interface AvatarImageInfo {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
}

function inspectPng(source: Buffer): AvatarImageInfo | null {
  if (
    source.length < 33
    || source.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || source.toString('ascii', 12, 16) !== 'IHDR'
    || !source.includes(Buffer.from('IEND', 'ascii'))
  ) return null;
  const width = source.readUInt32BE(16);
  const height = source.readUInt32BE(20);
  return validDimensions(width, height)
    ? { mediaType: 'image/png', extension: 'png', width, height }
    : null;
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function inspectJpeg(source: Buffer): AvatarImageInfo | null {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= source.length) {
    while (offset < source.length && source[offset] === 0xff) offset += 1;
    const marker = source[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === undefined || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > source.length) return null;
    const length = source.readUInt16BE(offset);
    if (length < 2 || offset + length > source.length) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = source.readUInt16BE(offset + 3);
      const width = source.readUInt16BE(offset + 5);
      return validDimensions(width, height)
        ? { mediaType: 'image/jpeg', extension: 'jpg', width, height }
        : null;
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(source: Buffer, offset: number): number {
  return source[offset]! | (source[offset + 1]! << 8) | (source[offset + 2]! << 16);
}

function inspectWebp(source: Buffer): AvatarImageInfo | null {
  if (
    source.length < 30
    || source.toString('ascii', 0, 4) !== 'RIFF'
    || source.toString('ascii', 8, 12) !== 'WEBP'
    || source.readUInt32LE(4) + 8 > source.length
  ) return null;
  const kind = source.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (kind === 'VP8X' && source.length >= 30) {
    width = readUInt24LE(source, 24) + 1;
    height = readUInt24LE(source, 27) + 1;
  } else if (kind === 'VP8L' && source.length >= 25 && source[20] === 0x2f) {
    width = 1 + (source[21]! | ((source[22]! & 0x3f) << 8));
    height = 1 + ((source[22]! >> 6) | (source[23]! << 2) | ((source[24]! & 0x0f) << 10));
  } else if (
    kind === 'VP8 '
    && source.length >= 30
    && source[23] === 0x9d
    && source[24] === 0x01
    && source[25] === 0x2a
  ) {
    width = source.readUInt16LE(26) & 0x3fff;
    height = source.readUInt16LE(28) & 0x3fff;
  }
  return validDimensions(width, height)
    ? { mediaType: 'image/webp', extension: 'webp', width, height }
    : null;
}

export function inspectAvatarImage(source: Buffer): AvatarImageInfo | null {
  return inspectPng(source) ?? inspectJpeg(source) ?? inspectWebp(source);
}

export function validateAvatarUpload(source: Buffer): AvatarImageInfo {
  if (source.length > AVATAR_IMAGE_POLICY.maxUploadBytes) {
    throw new Error('AVATAR_TOO_LARGE');
  }
  const image = inspectAvatarImage(source);
  if (!image) throw new Error('AVATAR_INVALID');
  if (
    image.width > AVATAR_IMAGE_POLICY.maxDimension
    || image.height > AVATAR_IMAGE_POLICY.maxDimension
  ) throw new Error('AVATAR_DIMENSIONS_TOO_LARGE');
  return image;
}
