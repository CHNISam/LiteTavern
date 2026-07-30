/**
 * Read a character card in the browser.
 *
 * The importer already sends the file to the model service, which parses it and stores
 * the character. This reads the same file a second time, locally, for one thing the
 * server cannot hand back: the card's embedded `character_book`. Worldbooks are a local
 * asset now, so a card's lorebook has to be lifted into this browser's library — and it
 * has to happen on every deployment, including one whose API knows nothing about
 * worldbooks at all.
 *
 * Only the two containers the importer accepts are handled: a JSON card, and a PNG with
 * the card in a tEXt chunk (`chara` for V2, `ccv3` for V3). Anything else reads as "no
 * card data here", which the caller treats as "this card has no worldbook".
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = atob(value.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Walk the PNG chunk list and collect tEXt keyword/value pairs.
 *
 * Chunks are `[length:4][type:4][data:length][crc:4]`, and a tEXt payload is
 * `keyword\0text`. The walk stops at IEND, and any length that would run past the end
 * of the buffer aborts it — a truncated upload must not turn into a decode loop.
 */
export function readPngTextChunks(bytes: Uint8Array): Record<string, string> {
  const chunks: Record<string, string> = {};
  if (!isPng(bytes)) return chunks;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = new TextDecoder('latin1');
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataEnd);
      const separator = data.indexOf(0);
      if (separator > 0) {
        const keyword = ascii.decode(data.subarray(0, separator));
        chunks[keyword] = ascii.decode(data.subarray(separator + 1));
      }
    }
    offset = dataEnd + 4;
  }
  return chunks;
}

/** The card object inside a PNG, preferring V3 over the older V2 chunk. */
export function cardDataFromPngChunks(
  chunks: Record<string, string>
): Record<string, unknown> | null {
  for (const keyword of ['ccv3', 'chara']) {
    const encoded = chunks[keyword];
    if (!encoded) continue;
    const json = decodeBase64Utf8(encoded);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A chunk that is not the card (or is damaged) is skipped, not fatal.
    }
  }
  return null;
}

export async function readCardFile(
  file: Blob
): Promise<Record<string, unknown> | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPng(bytes)) return cardDataFromPngChunks(readPngTextChunks(bytes));
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The `character_book` of a card, wherever the card keeps it.
 *
 * V2 and V3 nest the fields under `data`; a V1 card that somehow carries one keeps it
 * at the root. Both are checked so an import never silently drops a lorebook because of
 * where its author put it.
 */
export function embeddedCharacterBook(
  cardData: Record<string, unknown> | null
): unknown {
  if (!cardData) return null;
  const data =
    cardData.data && typeof cardData.data === 'object'
      ? (cardData.data as Record<string, unknown>)
      : {};
  return data.character_book ?? cardData.character_book ?? null;
}

export interface LocalCardPreview {
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

function text(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return '';
}

export function previewCardData(
  cardData: Record<string, unknown> | null,
  png = false
): LocalCardPreview {
  if (!cardData) throw new Error('角色卡数据无法读取。');
  const data =
    cardData.data && typeof cardData.data === 'object'
      ? (cardData.data as Record<string, unknown>)
      : cardData;
  const name = text(data, 'name', 'char_name').trim();
  if (!name) throw new Error('角色卡缺少角色名称。');
  const spec = text(cardData, 'spec').toLowerCase();
  const version = spec.includes('v3')
    ? 'CCV3'
    : cardData.data
      ? 'CCV2'
      : 'CCV1';
  const extensions =
    data.extensions && typeof data.extensions === 'object'
      ? (data.extensions as Record<string, unknown>)
      : {};
  const known = new Set([
    'regex_scripts',
    'regexScripts',
    'depth_prompt',
    'talkativeness',
    'fav'
  ]);
  const unapplied = Object.keys(extensions)
    .filter((key) => !known.has(key))
    .map((key) => `data.extensions.${key}`);
  return {
    format: `${version}_${png ? 'PNG' : 'JSON'}`,
    character: {
      name,
      description: text(data, 'description', 'char_persona'),
      personality: text(data, 'personality'),
      firstMessage: text(data, 'first_mes', 'first_message', 'char_greeting')
    },
    compatibility: {
      level: unapplied.length ? 'COMPATIBLE' : 'FORMAL',
      unapplied_fields: unapplied
    },
    warnings: []
  };
}

/** Regex scripts embedded by SillyTavern-compatible cards. */
export function embeddedRegexScripts(
  cardData: Record<string, unknown> | null
): unknown[] {
  if (!cardData) return [];
  const data =
    cardData.data && typeof cardData.data === 'object'
      ? (cardData.data as Record<string, unknown>)
      : {};
  const dataExtensions =
    data.extensions && typeof data.extensions === 'object'
      ? (data.extensions as Record<string, unknown>)
      : {};
  const rootExtensions =
    cardData.extensions && typeof cardData.extensions === 'object'
      ? (cardData.extensions as Record<string, unknown>)
      : {};
  const scripts =
    dataExtensions.regex_scripts ??
    dataExtensions.regexScripts ??
    rootExtensions.regex_scripts ??
    rootExtensions.regexScripts;
  return Array.isArray(scripts) ? scripts : [];
}

function cloneCard(cardData: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(cardData);
}

export function overlayLocalCardExtensions(
  cardData: Record<string, unknown>,
  characterBook: unknown,
  regexScripts: unknown[]
): Record<string, unknown> {
  const next = cloneCard(cardData);
  const hasData = next.data && typeof next.data === 'object';
  const target = hasData
    ? (next.data as Record<string, unknown>)
    : next;
  if (characterBook) target.character_book = characterBook;
  const extensions =
    target.extensions && typeof target.extensions === 'object'
      ? { ...(target.extensions as Record<string, unknown>) }
      : {};
  if (regexScripts.length) extensions.regex_scripts = regexScripts;
  if (Object.keys(extensions).length) target.extensions = extensions;
  return next;
}

function encodeBase64Utf8(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngTextChunk(keyword: string, text: string): Uint8Array {
  const type = new TextEncoder().encode('tEXt');
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let index = 0; index < keyword.length; index += 1) {
    data[index] = keyword.charCodeAt(index);
  }
  data[keyword.length] = 0;
  for (let index = 0; index < text.length; index += 1) {
    data[keyword.length + 1 + index] = text.charCodeAt(index);
  }
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(type, 4);
  output.set(data, 8);
  const checksumInput = new Uint8Array(type.length + data.length);
  checksumInput.set(type);
  checksumInput.set(data, type.length);
  view.setUint32(8 + data.length, crc32(checksumInput));
  return output;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Rewrite card metadata while retaining every non-card PNG chunk byte-for-byte. */
export function rewritePngCardMetadata(
  bytes: Uint8Array,
  cardData: Record<string, unknown>
): Uint8Array {
  if (!isPng(bytes)) throw new Error('不是有效的 PNG 角色卡。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = new TextDecoder('latin1');
  const parts: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let inserted = false;
  const spec = typeof cardData.spec === 'string' ? cardData.spec : '';
  const keyword = spec.toLowerCase().includes('v3') ? 'ccv3' : 'chara';
  const cardChunk = pngTextChunk(keyword, encodeBase64Utf8(cardData));
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG 角色卡已损坏。');
    const type = ascii.decode(bytes.subarray(offset + 4, offset + 8));
    let isCardChunk = false;
    if (type === 'tEXt') {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      const chunkKeyword =
        separator > 0 ? ascii.decode(data.subarray(0, separator)) : '';
      isCardChunk = chunkKeyword === 'chara' || chunkKeyword === 'ccv3';
    }
    if (type === 'IEND' && !inserted) {
      parts.push(cardChunk);
      inserted = true;
    }
    if (!isCardChunk) parts.push(bytes.slice(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return concatBytes(parts);
}

export async function rewriteCardFile(
  file: Blob,
  characterBook: unknown,
  regexScripts: unknown[]
): Promise<Blob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const card = await readCardFile(file);
  if (!card) throw new Error('角色卡数据无法读取。');
  const overlaid = overlayLocalCardExtensions(card, characterBook, regexScripts);
  if (isPng(bytes)) {
    const rewritten = Uint8Array.from(rewritePngCardMetadata(bytes, overlaid));
    return new Blob([rewritten.buffer], {
      type: 'image/png'
    });
  }
  return new Blob([JSON.stringify(overlaid, null, 2)], {
    type: 'application/json'
  });
}
