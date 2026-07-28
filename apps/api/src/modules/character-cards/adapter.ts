import { deflateSync } from 'node:zlib';

export type CharacterCardFormat =
  | 'CCV1_JSON'
  | 'CCV1_PNG'
  | 'CCV2_JSON'
  | 'CCV2_PNG'
  | 'CCV3_JSON'
  | 'CCV3_PNG';

export type CharacterCardContainer = 'JSON' | 'PNG';
export type CompatibilityLevel = 'FORMAL' | 'COMPATIBLE' | 'PRESERVED';

export interface NormalizedCharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_message: string;
  alternate_greetings: string[];
  example_messages: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  creator: {
    name: string;
    notes: string;
    character_version: string;
  };
}

export interface CharacterCardPassthrough {
  root: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface CharacterCardSourceMetadata {
  format: 'TAVERN_CARD_V1' | 'CHARACTER_CARD_V2' | 'CHARACTER_CARD_V3' | 'INTERNAL';
  container: CharacterCardContainer | 'INTERNAL';
  spec_version: string;
  compatibility_level: CompatibilityLevel;
  parser_id: string;
  parser_version: string;
  unapplied_fields: string[];
  file_name?: string;
  media_type?: string;
  file_size?: number;
  checksum_sha256?: string;
}

export interface AdapterDetection {
  score: number;
  container: CharacterCardContainer;
}

interface AdapterParseResult {
  format: CharacterCardFormat;
  specVersion: string;
  normalizedData: NormalizedCharacterCard;
  passthroughData: CharacterCardPassthrough;
  sourceMetadata: CharacterCardSourceMetadata;
  warnings: string[];
  source: Record<string, unknown>;
}

export interface CharacterCardAdapter {
  id: string;
  detect(source: Buffer): AdapterDetection | null;
  parse(source: Buffer, detection: AdapterDetection): AdapterParseResult;
  export(
    normalized: NormalizedCharacterCard,
    passthrough: CharacterCardPassthrough,
    format: CharacterCardFormat,
    options?: ExportCharacterCardOptions
  ): Buffer;
  supportsFormat?(format: CharacterCardFormat): boolean;
}

export interface ParsedCharacterCard extends AdapterParseResult {
  character: {
    name: string;
    description: string;
    personality: string;
    firstMessage: string;
  };
  preserved: Record<string, unknown>;
}

export interface ExportCharacterCardOptions {
  extraTextChunks?: Record<string, string>;
  basePng?: Buffer;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08])
];
const MAX_CARD_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 500_000;
const PARSER_VERSION = '0.2.0';

function cardError(code: string): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}

function validateTree(value: unknown, depth = 0): void {
  if (depth > 32) throw cardError('CHARACTER_CARD_INVALID');
  if (typeof value === 'string' && value.length > MAX_TEXT_LENGTH) {
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

interface PngChunk {
  type: string;
  data: Buffer;
}

function readPngChunks(source: Buffer, validateImageChunks = true): PngChunk[] {
  if (source.length < 8 || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  const chunks: PngChunk[] = [];
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_CARD_BYTES || end > source.length) throw cardError('CHARACTER_CARD_INVALID');
    const type = source.toString('ascii', offset + 4, offset + 8);
    const data = Buffer.from(source.subarray(offset + 8, offset + 8 + length));
    const expectedCrc = source.readUInt32BE(offset + 8 + length);
    if (
      (validateImageChunks || type === 'tEXt')
      && crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== expectedCrc
    ) {
      throw cardError('CHARACTER_CARD_INVALID');
    }
    chunks.push({ type, data });
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw cardError('CHARACTER_CARD_INVALID');
  return chunks;
}

function pngTextChunks(source: Buffer): Map<string, string> {
  const text = new Map<string, string>();
  // Avatar pixels are optional. A damaged IDAT must not hide otherwise intact,
  // checksummed character metadata from the importer.
  for (const chunk of readPngChunks(source, false)) {
    if (chunk.type !== 'tEXt') continue;
    const separator = chunk.data.indexOf(0);
    if (separator <= 0) continue;
    const keyword = chunk.data.toString('latin1', 0, separator).toLowerCase();
    text.set(keyword, chunk.data.toString('latin1', separator + 1));
  }
  return text;
}

function decodeBase64Json(encoded: string): Record<string, unknown> {
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.length) throw cardError('CHARACTER_CARD_INVALID');
  return parseJson(decoded);
}

function decodeDocument(
  source: Buffer,
  keyword: 'chara' | 'ccv3'
): { container: CharacterCardContainer; document: Record<string, unknown> } | null {
  if (source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const encoded = pngTextChunks(source).get(keyword);
    return encoded ? { container: 'PNG', document: decodeBase64Json(encoded) } : null;
  }
  return { container: 'JSON', document: parseJson(source) };
}

function readString(record: Record<string, unknown>, key: string): string {
  if (!(key in record)) return '';
  if (typeof record[key] !== 'string') throw cardError('CHARACTER_CARD_INVALID');
  return record[key].slice(0, MAX_TEXT_LENGTH);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  if (!(key in record)) return [];
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  return value.map((item) => item.slice(0, MAX_TEXT_LENGTH));
}

const MAPPED_DATA_FIELDS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'first_message',
  'alternate_greetings',
  'mes_example',
  'example_messages',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'creator',
  'creator_notes',
  'character_version'
]);

const ROOT_FIELDS = new Set(['spec', 'spec_version', 'data']);

function pickUnknown(
  record: Record<string, unknown>,
  known: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => [key, structuredClone(value)])
  );
}

function normalizeData(record: Record<string, unknown>): NormalizedCharacterCard {
  const name = readString(record, 'name').trim();
  if (!name || name.length > 200) throw cardError('CHARACTER_CARD_INVALID');
  const firstMessage = 'first_mes' in record
    ? readString(record, 'first_mes')
    : readString(record, 'first_message');
  const exampleMessages = 'mes_example' in record
    ? readString(record, 'mes_example')
    : readString(record, 'example_messages');
  return {
    name,
    description: readString(record, 'description'),
    personality: readString(record, 'personality'),
    scenario: readString(record, 'scenario'),
    first_message: firstMessage,
    alternate_greetings: readStringArray(record, 'alternate_greetings'),
    example_messages: exampleMessages,
    system_prompt: readString(record, 'system_prompt'),
    post_history_instructions: readString(record, 'post_history_instructions'),
    tags: readStringArray(record, 'tags'),
    creator: {
      name: readString(record, 'creator'),
      notes: readString(record, 'creator_notes'),
      character_version: readString(record, 'character_version')
    }
  };
}

export function validateNormalizedCharacterCard(value: unknown): NormalizedCharacterCard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  const record = value as Record<string, unknown>;
  const creator = record.creator;
  if (!creator || typeof creator !== 'object' || Array.isArray(creator)) {
    throw cardError('CHARACTER_CARD_INVALID');
  }
  const flat: Record<string, unknown> = {
    ...record,
    creator: (creator as Record<string, unknown>).name,
    creator_notes: (creator as Record<string, unknown>).notes,
    character_version: (creator as Record<string, unknown>).character_version,
    first_mes: record.first_message,
    mes_example: record.example_messages
  };
  return normalizeData(flat);
}

function sourceFormat(version: 1 | 2 | 3, container: CharacterCardContainer): CharacterCardFormat {
  return `CCV${version}_${container}` as CharacterCardFormat;
}

function buildUnappliedFields(
  passthrough: CharacterCardPassthrough,
  normalized: NormalizedCharacterCard
): string[] {
  const fields = [
    ...Object.keys(passthrough.root).map((key) => key),
    ...Object.keys(passthrough.data).map((key) => `data.${key}`)
  ];
  if (normalized.alternate_greetings.length) fields.push('data.alternate_greetings');
  return [...new Set(fields)].sort();
}

function warningsFor(
  level: CompatibilityLevel,
  unappliedFields: string[],
  version: 1 | 2 | 3,
  specVersion: string
): string[] {
  const warnings: string[] = [];
  if (version === 1) {
    warnings.push('这是旧版 Tavern Card V1，LiteTavern 已按兼容模式导入。');
  } else if (level === 'COMPATIBLE') {
    warnings.push(`角色卡规范版本 ${specVersion} 与当前正式支持版本不同，已按兼容模式导入。`);
  }
  if (unappliedFields.length) {
    warnings.push('部分字段已保留但当前不会参与聊天运行，导出时会尽量保留。');
  }
  return warnings;
}

class VersionedCharacterCardAdapter implements CharacterCardAdapter {
  readonly id: string;

  constructor(private readonly version: 2 | 3) {
    this.id = `pomchat/character-card-v${version}`;
  }

  detect(source: Buffer): AdapterDetection | null {
    const keyword = this.version === 3 ? 'ccv3' : 'chara';
    let decoded;
    try {
      decoded = decodeDocument(source, keyword);
    } catch {
      return null;
    }
    if (!decoded) return null;
    const spec = decoded.document.spec;
    const data = decoded.document.data;
    if (
      spec !== `chara_card_v${this.version}`
      || !data
      || typeof data !== 'object'
      || Array.isArray(data)
    ) return null;
    return { score: this.version === 3 ? 300 : 200, container: decoded.container };
  }

  parse(source: Buffer, detection: AdapterDetection): AdapterParseResult {
    const keyword = this.version === 3 ? 'ccv3' : 'chara';
    const decoded = decodeDocument(source, keyword);
    if (!decoded) throw cardError('CHARACTER_CARD_INVALID');
    const document = decoded.document;
    if (typeof document.spec_version !== 'string' && 'spec_version' in document) {
      throw cardError('CHARACTER_CARD_INVALID');
    }
    const specVersion = typeof document.spec_version === 'string'
      ? document.spec_version
      : `${this.version}.0`;
    const data = document.data as Record<string, unknown>;
    const normalized = normalizeData(data);
    const passthrough = {
      root: pickUnknown(document, ROOT_FIELDS),
      data: pickUnknown(data, MAPPED_DATA_FIELDS)
    };
    const expected = `${this.version}.0`;
    const compatibilityLevel: CompatibilityLevel = specVersion === expected
      ? 'FORMAL'
      : 'COMPATIBLE';
    const unappliedFields = buildUnappliedFields(passthrough, normalized);
    return {
      format: sourceFormat(this.version, detection.container),
      specVersion,
      normalizedData: normalized,
      passthroughData: passthrough,
      sourceMetadata: {
        format: `CHARACTER_CARD_V${this.version}`,
        container: detection.container,
        spec_version: specVersion,
        compatibility_level: compatibilityLevel,
        parser_id: this.id,
        parser_version: PARSER_VERSION,
        unapplied_fields: unappliedFields
      },
      warnings: warningsFor(
        compatibilityLevel,
        unappliedFields,
        this.version,
        specVersion
      ),
      source: structuredClone(document)
    };
  }

  supportsFormat(format: CharacterCardFormat): boolean {
    return format.startsWith(`CCV${this.version}_`);
  }

  export(
    normalized: NormalizedCharacterCard,
    passthrough: CharacterCardPassthrough,
    format: CharacterCardFormat,
    options: ExportCharacterCardOptions = {}
  ): Buffer {
    return serializeDocument(buildDocument(normalized, passthrough, format), format, options);
  }
}

class TavernCardV1Adapter implements CharacterCardAdapter {
  readonly id = 'pomchat/tavern-card-v1';

  detect(source: Buffer): AdapterDetection | null {
    let decoded;
    try {
      decoded = decodeDocument(source, 'chara');
    } catch {
      return null;
    }
    if (!decoded) return null;
    const document = decoded.document;
    if ('spec' in document || 'data' in document || typeof document.name !== 'string') return null;
    const hasCardField = ['description', 'personality', 'scenario', 'first_mes', 'mes_example']
      .some((field) => field in document);
    return hasCardField ? { score: 100, container: decoded.container } : null;
  }

  parse(source: Buffer, detection: AdapterDetection): AdapterParseResult {
    const decoded = decodeDocument(source, 'chara');
    if (!decoded) throw cardError('CHARACTER_CARD_INVALID');
    const normalized = normalizeData(decoded.document);
    const passthrough = {
      root: pickUnknown(decoded.document, MAPPED_DATA_FIELDS),
      data: {}
    };
    const unappliedFields = buildUnappliedFields(passthrough, normalized);
    return {
      format: sourceFormat(1, detection.container),
      specVersion: '1.0',
      normalizedData: normalized,
      passthroughData: passthrough,
      sourceMetadata: {
        format: 'TAVERN_CARD_V1',
        container: detection.container,
        spec_version: '1.0',
        compatibility_level: 'COMPATIBLE',
        parser_id: this.id,
        parser_version: PARSER_VERSION,
        unapplied_fields: unappliedFields
      },
      warnings: warningsFor('COMPATIBLE', unappliedFields, 1, '1.0'),
      source: structuredClone(decoded.document)
    };
  }

  supportsFormat(format: CharacterCardFormat): boolean {
    return format.startsWith('CCV1_');
  }

  export(
    normalized: NormalizedCharacterCard,
    passthrough: CharacterCardPassthrough,
    format: CharacterCardFormat,
    options: ExportCharacterCardOptions = {}
  ): Buffer {
    return serializeDocument(buildDocument(normalized, passthrough, format), format, options);
  }
}

export class CharacterCardAdapterRegistry {
  constructor(private readonly adapters: readonly CharacterCardAdapter[]) {}

  parse(source: Buffer): ParsedCharacterCard {
    if (source.length > MAX_CARD_BYTES) throw cardError('CHARACTER_CARD_TOO_LARGE');
    const matches = this.adapters.flatMap((adapter) => {
      try {
        const detection = adapter.detect(source);
        return detection ? [{ adapter, detection }] : [];
      } catch {
        return [];
      }
    }).sort((left, right) => right.detection.score - left.detection.score);

    const selected = matches[0];
    if (!selected) {
      if (ZIP_SIGNATURES.some((signature) => source.subarray(0, 4).equals(signature))) {
        throw cardError('CHARACTER_CARD_FORMAT_UNSUPPORTED');
      }
      throw cardError('CHARACTER_CARD_INVALID');
    }
    const parsed = selected.adapter.parse(source, selected.detection);
    return {
      ...parsed,
      character: {
        name: parsed.normalizedData.name,
        description: parsed.normalizedData.description,
        personality: parsed.normalizedData.personality,
        firstMessage: parsed.normalizedData.first_message
      },
      preserved: structuredClone(parsed.source)
    };
  }

  export(
    normalized: NormalizedCharacterCard,
    passthrough: CharacterCardPassthrough,
    format: CharacterCardFormat,
    options: ExportCharacterCardOptions = {}
  ): Buffer {
    const adapter = this.adapters.find((candidate) => candidate.supportsFormat?.(format));
    if (!adapter) throw cardError('CHARACTER_CARD_FORMAT_UNSUPPORTED');
    return adapter.export(normalized, passthrough, format, options);
  }
}

const defaultRegistry = new CharacterCardAdapterRegistry([
  new VersionedCharacterCardAdapter(3),
  new VersionedCharacterCardAdapter(2),
  new TavernCardV1Adapter()
]);

export function parseCharacterCard(source: Buffer): ParsedCharacterCard {
  return defaultRegistry.parse(source);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function metadataChunk(format: CharacterCardFormat, document: Record<string, unknown>): PngChunk {
  const keyword = format.startsWith('CCV3') ? 'ccv3' : 'chara';
  const encoded = Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
  return {
    type: 'tEXt',
    data: Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(encoded, 'ascii')
    ])
  };
}

function placeholderPngChunks(): PngChunk[] {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return [
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: deflateSync(Buffer.from([0, 0, 0, 0, 0])) },
    { type: 'IEND', data: Buffer.alloc(0) }
  ];
}

function writePngMetadata(
  document: Record<string, unknown>,
  format: CharacterCardFormat,
  options: ExportCharacterCardOptions
): Buffer {
  let baseChunks = placeholderPngChunks();
  if (options.basePng) {
    try {
      baseChunks = readPngChunks(options.basePng);
    } catch {
      // Character metadata can remain valid when optional avatar pixels are
      // damaged. Export a safe placeholder carrier instead of failing the card.
      baseChunks = placeholderPngChunks();
    }
  }
  const extra = Object.entries(options.extraTextChunks ?? {}).map(([key, value]) => ({
    type: 'tEXt',
    data: Buffer.concat([
      Buffer.from(key, 'latin1'),
      Buffer.from([0]),
      Buffer.from(value, 'latin1')
    ])
  }));
  const kept = baseChunks.filter((chunk) => {
    if (chunk.type !== 'tEXt') return chunk.type !== 'IEND';
    const separator = chunk.data.indexOf(0);
    const keyword = separator > 0
      ? chunk.data.toString('latin1', 0, separator).toLowerCase()
      : '';
    return keyword !== 'chara' && keyword !== 'ccv3';
  });
  const chunks = [...kept, ...extra, metadataChunk(format, document), {
    type: 'IEND',
    data: Buffer.alloc(0)
  }];
  return Buffer.concat([
    PNG_SIGNATURE,
    ...chunks.map((chunk) => pngChunk(chunk.type, chunk.data))
  ]);
}

function serializeDocument(
  document: Record<string, unknown>,
  format: CharacterCardFormat,
  options: ExportCharacterCardOptions = {}
): Buffer {
  if (format.endsWith('_JSON')) return Buffer.from(JSON.stringify(document), 'utf8');
  return writePngMetadata(document, format, options);
}

function applyRootMirrors(
  root: Record<string, unknown>,
  data: Record<string, unknown>
): void {
  for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    if (field in root) root[field] = data[field];
  }
}

function buildDocument(
  normalized: NormalizedCharacterCard,
  passthrough: CharacterCardPassthrough,
  format: CharacterCardFormat
): Record<string, unknown> {
  const root = structuredClone(passthrough.root ?? {});
  if (format.startsWith('CCV1_')) {
    return {
      ...root,
      name: normalized.name,
      description: normalized.description,
      personality: normalized.personality,
      scenario: normalized.scenario,
      first_mes: normalized.first_message,
      mes_example: normalized.example_messages
    };
  }

  const version = format.startsWith('CCV3_') ? 3 : 2;
  const data: Record<string, unknown> = {
    ...structuredClone(passthrough.data ?? {}),
    name: normalized.name,
    description: normalized.description,
    personality: normalized.personality,
    scenario: normalized.scenario,
    first_mes: normalized.first_message,
    mes_example: normalized.example_messages,
    creator_notes: normalized.creator.notes,
    system_prompt: normalized.system_prompt,
    post_history_instructions: normalized.post_history_instructions,
    alternate_greetings: normalized.alternate_greetings,
    tags: normalized.tags,
    creator: normalized.creator.name,
    character_version: normalized.creator.character_version
  };
  if (!('extensions' in data)) data.extensions = {};
  if (version === 3 && !('group_only_greetings' in data)) data.group_only_greetings = [];
  applyRootMirrors(root, data);
  return {
    ...root,
    spec: `chara_card_v${version}`,
    spec_version: `${version}.0`,
    data
  };
}

export function exportCharacterCard(
  source: Record<string, unknown>,
  format: CharacterCardFormat,
  options: ExportCharacterCardOptions = {}
): Buffer {
  return serializeDocument(source, format, options);
}

export function exportNormalizedCharacterCard(
  normalized: NormalizedCharacterCard,
  passthrough: CharacterCardPassthrough,
  format: CharacterCardFormat,
  options: ExportCharacterCardOptions = {}
): Buffer {
  return defaultRegistry.export(
    validateNormalizedCharacterCard(normalized),
    passthrough,
    format,
    options
  );
}
