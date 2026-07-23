import { deflateSync } from 'node:zlib';

export type CharacterCardFormat = 'CCV2_JSON' | 'CCV2_PNG' | 'CCV3_JSON' | 'CCV3_PNG';

export interface NormalizedCharacterCard {
  name: string;
  description: string;
  personality: string;
  firstMessage: string;
}

export interface ParsedCharacterCard {
  format: CharacterCardFormat;
  specVersion: string;
  character: NormalizedCharacterCard;
  source: Record<string, unknown>;
  preserved: Record<string, unknown>;
  warnings: string[];
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CARD_BYTES = 10 * 1024 * 1024;

function cardError(code: string): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}

function validateTree(value: unknown, depth = 0): void {
  if (depth > 32) throw cardError('CHARACTER_CARD_INVALID');
  if (typeof value === 'string' && value.length > 500_000) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  if (Array.isArray(value)) {
    for (const item of value) validateTree(item, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) validateTree(item, depth + 1);
  }
}

function parseJson(source: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(source.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw cardError('CHARACTER_CARD_INVALID');
    }
    validateTree(parsed);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === 'CHARACTER_CARD_INVALID') throw error;
    throw cardError('CHARACTER_CARD_INVALID');
  }
}

function pngTextChunks(source: Buffer): Map<string, string> {
  if (source.length < 8 || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  const chunks = new Map<string, string>();
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_CARD_BYTES || end > source.length) throw cardError('CHARACTER_CARD_INVALID');
    const type = source.toString('ascii', offset + 4, offset + 8);
    const data = source.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator > 0) {
        chunks.set(data.toString('latin1', 0, separator), data.toString('latin1', separator + 1));
      }
    }
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw cardError('CHARACTER_CARD_INVALID');
  return chunks;
}

function normalize(source: Record<string, unknown>, fromPng: boolean): ParsedCharacterCard {
  const spec = typeof source.spec === 'string' ? source.spec : '';
  const specVersion = typeof source.spec_version === 'string' ? source.spec_version : '';
  const version = spec === 'chara_card_v3' || specVersion.startsWith('3') ? 3 :
    spec === 'chara_card_v2' || specVersion.startsWith('2') ? 2 : 0;
  if (!version) throw cardError('CHARACTER_CARD_INVALID');
  const data = source.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  const record = data as Record<string, unknown>;
  const read = (name: string) => (typeof record[name] === 'string' ? record[name] : '');
  const name = read('name').trim();
  if (!name || name.length > 200) throw cardError('CHARACTER_CARD_INVALID');
  const warnings: string[] = [];
  const knownRoot = new Set(['spec', 'spec_version', 'data']);
  if (Object.keys(source).some((key) => !knownRoot.has(key))) {
    warnings.push('角色卡包含 PomChat 未直接使用的字段，导出时会尽量保留。');
  }
  return {
    format: `CCV${version}_${fromPng ? 'PNG' : 'JSON'}` as CharacterCardFormat,
    specVersion: specVersion || `${version}.0`,
    character: {
      name,
      description: read('description').slice(0, 500_000),
      personality: read('personality').slice(0, 500_000),
      firstMessage: (read('first_mes') || read('first_message') || '你好。').slice(0, 500_000)
    },
    source,
    preserved: structuredClone(source),
    warnings
  };
}

export function parseCharacterCard(source: Buffer): ParsedCharacterCard {
  if (source.length > MAX_CARD_BYTES) throw cardError('CHARACTER_CARD_TOO_LARGE');
  if (source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const chunks = pngTextChunks(source);
    const encoded = chunks.get('ccv3') ?? chunks.get('chara');
    if (!encoded) throw cardError('CHARACTER_CARD_INVALID');
    let json: Buffer;
    try {
      json = Buffer.from(encoded, 'base64');
      if (!json.length) throw new Error('empty');
    } catch {
      throw cardError('CHARACTER_CARD_INVALID');
    }
    return normalize(parseJson(json), true);
  }
  return normalize(parseJson(source), false);
}

function crc32(source: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of source) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function exportCharacterCard(
  source: Record<string, unknown>,
  format: CharacterCardFormat,
  options: { extraTextChunks?: Record<string, string> } = {}
): Buffer {
  const json = Buffer.from(JSON.stringify(source), 'utf8');
  if (format.endsWith('_JSON')) return json;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const keyword = format === 'CCV3_PNG' ? 'ccv3' : 'chara';
  const textChunks = Object.entries(options.extraTextChunks ?? {}).map(([key, value]) =>
    pngChunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]))
  );
  textChunks.push(
    pngChunk(
      'tEXt',
      Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(json.toString('base64'), 'ascii')
      ])
    )
  );
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...textChunks,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}
