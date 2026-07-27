/**
 * Validation and normalization for the "migrate a relationship from another AI
 * platform" import format.
 *
 * The payload is produced by an external model the user runs themselves — PomChat
 * never calls a model here. Everything inside it is therefore treated as untrusted
 * user data: it is length-capped, count-capped, never executed, and never logged.
 * Unknown fields are reported but kept only in the raw payload record.
 */

export const RELATIONSHIP_IMPORT_SCHEMA_VERSION = 'pomchat_relationship_import_v1';

// Resource limits. They exist so a malformed or hostile payload cannot exhaust
// memory, the database, or the model context that later recalls this data.
export const IMPORT_LIMITS = {
  maxPayloadBytes: 1024 * 1024,
  maxNameLength: 200,
  maxDescriptionLength: 4000,
  maxSummaryLength: 4000,
  maxStageLength: 200,
  maxShortItemLength: 300,
  maxListItems: 50,
  maxMemories: 200,
  maxMemoryContentLength: 1000,
  maxEvidenceLength: 500,
  maxTags: 10,
  maxTagLength: 40,
  maxUncertainItems: 50,
  maxReasonLength: 500,
  maxNotesLength: 1000
} as const;

export type ImportIssueSeverity = 'FATAL' | 'WARNING' | 'INFO';

export interface ImportIssue {
  severity: ImportIssueSeverity;
  code: string;
  path: string;
  message: string;
}

export interface NormalizedImportMemory {
  /** Stable per-payload key so the client can select/deselect and edit entries. */
  key: string;
  content: string;
  /** 1–10 as authored. Scaled down when written to agent_memory (1–5). */
  importance: number;
  approximate_time: string | null;
  tags: string[];
  evidence_summary: string;
  /** Key of the first memory with identical content, when this one repeats it. */
  duplicate_of?: string;
}

export interface NormalizedRelationshipImport {
  character: {
    name: string;
    description: string;
    personality_traits: string[];
    speaking_style: string[];
  };
  user_profile: {
    preferred_name: string;
    facts: string[];
    preferences: string[];
    boundaries: string[];
  };
  relationship: {
    summary: string;
    stage: string;
    interaction_patterns: string[];
  };
  memories: NormalizedImportMemory[];
  unfinished_threads: string[];
  uncertain_items: { content: string; reason: string }[];
  source_metadata: {
    source_platform: string;
    character_name_on_source: string;
    processed_at: string;
    notes: string;
  };
}

export interface NormalizeResult {
  ok: boolean;
  issues: ImportIssue[];
  data: NormalizedRelationshipImport | null;
  unknown_fields: string[];
}

const KNOWN_ROOT_KEYS = [
  'schema_version', 'character', 'user_profile', 'relationship',
  'memories', 'unfinished_threads', 'uncertain_items', 'source_metadata'
];
const KNOWN_KEYS: Record<string, string[]> = {
  character: ['name', 'description', 'personality_traits', 'speaking_style'],
  user_profile: ['preferred_name', 'facts', 'preferences', 'boundaries'],
  relationship: ['summary', 'stage', 'interaction_patterns'],
  memory: ['content', 'importance', 'approximate_time', 'tags', 'evidence_summary'],
  uncertain_item: ['content', 'reason'],
  source_metadata: ['source_platform', 'character_name_on_source', 'processed_at', 'notes']
};

const APPROXIMATE_TIME_PATTERN = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class IssueCollector {
  readonly issues: ImportIssue[] = [];
  readonly unknownFields: string[] = [];

  add(severity: ImportIssueSeverity, code: string, path: string, message: string) {
    this.issues.push({ severity, code, path, message });
  }

  hasFatal(): boolean {
    return this.issues.some((issue) => issue.severity === 'FATAL');
  }

  unknown(container: Record<string, unknown>, known: string[], prefix: string) {
    for (const key of Object.keys(container)) {
      if (known.includes(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      this.unknownFields.push(path);
    }
  }
}

/** Collapses whitespace and strips control characters that would break rendering. */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function takeText(
  value: unknown,
  max: number,
  path: string,
  collector: IssueCollector
): string {
  const text = cleanText(value);
  if (text.length <= max) return text;
  collector.add(
    'WARNING',
    'FIELD_TRUNCATED',
    path,
    `内容超过 ${max} 字，已截断保留前 ${max} 字。`
  );
  return text.slice(0, max);
}

function takeList(
  value: unknown,
  path: string,
  collector: IssueCollector,
  options: { maxItems?: number; maxLength?: number } = {}
): string[] {
  const maxItems = options.maxItems ?? IMPORT_LIMITS.maxListItems;
  const maxLength = options.maxLength ?? IMPORT_LIMITS.maxShortItemLength;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    collector.add('WARNING', 'FIELD_TYPE_IGNORED', path, '该字段不是列表，已按空列表处理。');
    return [];
  }
  const items: string[] = [];
  for (const [index, raw] of value.entries()) {
    if (items.length >= maxItems) {
      collector.add(
        'WARNING',
        'LIST_TRUNCATED',
        path,
        `列表超过 ${maxItems} 条，多余的内容未导入。`
      );
      break;
    }
    const text = takeText(raw, maxLength, `${path}[${index}]`, collector);
    if (text) items.push(text);
  }
  return items;
}

function normalizeImportance(
  value: unknown,
  path: string,
  collector: IssueCollector
): number {
  if (value === undefined || value === null) {
    collector.add('WARNING', 'IMPORTANCE_MISSING', path, '缺少重要度，已按 5 处理。');
    return 5;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    collector.add('WARNING', 'IMPORTANCE_INVALID', path, '重要度不是数字，已按 5 处理。');
    return 5;
  }
  const rounded = Math.round(numeric);
  if (rounded < 1 || rounded > 10) {
    const clamped = Math.min(10, Math.max(1, rounded));
    collector.add(
      'WARNING',
      'IMPORTANCE_OUT_OF_RANGE',
      path,
      `重要度 ${numeric} 超出 1–10，已调整为 ${clamped}。`
    );
    return clamped;
  }
  return rounded;
}

function normalizeApproximateTime(
  value: unknown,
  path: string,
  collector: IssueCollector
): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = cleanText(value);
  if (!text) return null;
  const match = APPROXIMATE_TIME_PATTERN.exec(text);
  const month = match?.[2] ? Number(match[2]) : null;
  const day = match?.[3] ? Number(match[3]) : null;
  const valid = Boolean(match)
    && (month === null || (month >= 1 && month <= 12))
    && (day === null || (day >= 1 && day <= 31));
  if (!valid) {
    collector.add(
      'WARNING',
      'TIME_FORMAT_INVALID',
      path,
      `时间“${text}”不是 YYYY、YYYY-MM 或 YYYY-MM-DD 格式，已忽略该时间。`
    );
    return null;
  }
  return text;
}

function normalizeMemories(
  value: unknown,
  collector: IssueCollector
): NormalizedImportMemory[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    collector.add('WARNING', 'FIELD_TYPE_IGNORED', 'memories', '该字段不是列表，已按空列表处理。');
    return [];
  }
  const memories: NormalizedImportMemory[] = [];
  const seen = new Map<string, string>();
  for (const [index, raw] of value.entries()) {
    if (memories.length >= IMPORT_LIMITS.maxMemories) {
      collector.add(
        'WARNING',
        'LIST_TRUNCATED',
        'memories',
        `记忆超过 ${IMPORT_LIMITS.maxMemories} 条，多余的内容未导入。`
      );
      break;
    }
    const path = `memories[${index}]`;
    if (!isRecord(raw)) {
      collector.add('WARNING', 'MEMORY_IGNORED', path, '该条记忆不是对象，已忽略。');
      continue;
    }
    collector.unknown(raw, KNOWN_KEYS.memory ?? [], path);
    const content = takeText(
      raw.content,
      IMPORT_LIMITS.maxMemoryContentLength,
      `${path}.content`,
      collector
    );
    if (!content) {
      collector.add('WARNING', 'MEMORY_EMPTY', path, '该条记忆内容为空，已忽略。');
      continue;
    }
    const key = `m${index}`;
    const memory: NormalizedImportMemory = {
      key,
      content,
      importance: normalizeImportance(raw.importance, `${path}.importance`, collector),
      approximate_time: normalizeApproximateTime(
        raw.approximate_time,
        `${path}.approximate_time`,
        collector
      ),
      tags: takeList(raw.tags, `${path}.tags`, collector, {
        maxItems: IMPORT_LIMITS.maxTags,
        maxLength: IMPORT_LIMITS.maxTagLength
      }),
      evidence_summary: takeText(
        raw.evidence_summary,
        IMPORT_LIMITS.maxEvidenceLength,
        `${path}.evidence_summary`,
        collector
      )
    };
    // Repeats are only flagged. They are never dropped automatically: two entries
    // with the same wording can still describe different moments in time.
    const previous = seen.get(content);
    if (previous) {
      memory.duplicate_of = previous;
      collector.add(
        'WARNING',
        'MEMORY_DUPLICATE',
        path,
        '这条记忆与前面某条内容完全相同，请确认是否都要导入。'
      );
    } else {
      seen.set(content, key);
    }
    memories.push(memory);
  }
  return memories;
}

function normalizeUncertainItems(
  value: unknown,
  collector: IssueCollector
): { content: string; reason: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    collector.add(
      'WARNING',
      'FIELD_TYPE_IGNORED',
      'uncertain_items',
      '该字段不是列表，已按空列表处理。'
    );
    return [];
  }
  const items: { content: string; reason: string }[] = [];
  for (const [index, raw] of value.entries()) {
    if (items.length >= IMPORT_LIMITS.maxUncertainItems) {
      collector.add(
        'WARNING',
        'LIST_TRUNCATED',
        'uncertain_items',
        `不确定信息超过 ${IMPORT_LIMITS.maxUncertainItems} 条，多余的内容未导入。`
      );
      break;
    }
    const path = `uncertain_items[${index}]`;
    if (!isRecord(raw)) {
      const content = takeText(raw, IMPORT_LIMITS.maxMemoryContentLength, path, collector);
      if (content) items.push({ content, reason: '' });
      continue;
    }
    collector.unknown(raw, KNOWN_KEYS.uncertain_item ?? [], path);
    const content = takeText(
      raw.content,
      IMPORT_LIMITS.maxMemoryContentLength,
      `${path}.content`,
      collector
    );
    if (!content) continue;
    items.push({
      content,
      reason: takeText(raw.reason, IMPORT_LIMITS.maxReasonLength, `${path}.reason`, collector)
    });
  }
  return items;
}

/**
 * Validates and normalizes an already-parsed payload. Fatal issues stop the import;
 * warnings are surfaced for the user to review and can be accepted as-is.
 */
export function normalizeRelationshipImport(payload: unknown): NormalizeResult {
  const collector = new IssueCollector();

  if (!isRecord(payload)) {
    collector.add('FATAL', 'PAYLOAD_NOT_OBJECT', '', '导入内容必须是一个 JSON 对象。');
    return { ok: false, issues: collector.issues, data: null, unknown_fields: [] };
  }

  collector.unknown(payload, KNOWN_ROOT_KEYS, '');

  const schemaVersion = cleanText(payload.schema_version);
  if (!schemaVersion) {
    collector.add(
      'FATAL',
      'SCHEMA_VERSION_MISSING',
      'schema_version',
      `缺少 schema_version，需要 ${RELATIONSHIP_IMPORT_SCHEMA_VERSION}。`
    );
  } else if (schemaVersion !== RELATIONSHIP_IMPORT_SCHEMA_VERSION) {
    collector.add(
      'FATAL',
      'SCHEMA_VERSION_UNSUPPORTED',
      'schema_version',
      `不支持的 schema_version“${schemaVersion}”，当前只支持 ${RELATIONSHIP_IMPORT_SCHEMA_VERSION}。`
    );
  }

  const characterRaw = isRecord(payload.character) ? payload.character : {};
  collector.unknown(characterRaw, KNOWN_KEYS.character ?? [], 'character');
  const name = takeText(
    characterRaw.name,
    IMPORT_LIMITS.maxNameLength,
    'character.name',
    collector
  );
  if (!name) {
    collector.add('FATAL', 'CHARACTER_NAME_MISSING', 'character.name', '缺少角色名称。');
  }

  const relationshipRaw = isRecord(payload.relationship) ? payload.relationship : {};
  collector.unknown(relationshipRaw, KNOWN_KEYS.relationship ?? [], 'relationship');
  const summary = takeText(
    relationshipRaw.summary,
    IMPORT_LIMITS.maxSummaryLength,
    'relationship.summary',
    collector
  );
  if (!summary) {
    collector.add(
      'FATAL',
      'RELATIONSHIP_SUMMARY_MISSING',
      'relationship.summary',
      '缺少关系摘要。'
    );
  }

  const userProfileRaw = isRecord(payload.user_profile) ? payload.user_profile : {};
  collector.unknown(userProfileRaw, KNOWN_KEYS.user_profile ?? [], 'user_profile');
  const sourceRaw = isRecord(payload.source_metadata) ? payload.source_metadata : {};
  collector.unknown(sourceRaw, KNOWN_KEYS.source_metadata ?? [], 'source_metadata');

  const memories = normalizeMemories(payload.memories, collector);
  const uncertainItems = normalizeUncertainItems(payload.uncertain_items, collector);

  const data: NormalizedRelationshipImport = {
    character: {
      name,
      description: takeText(
        characterRaw.description,
        IMPORT_LIMITS.maxDescriptionLength,
        'character.description',
        collector
      ),
      personality_traits: takeList(
        characterRaw.personality_traits,
        'character.personality_traits',
        collector
      ),
      speaking_style: takeList(
        characterRaw.speaking_style,
        'character.speaking_style',
        collector
      )
    },
    user_profile: {
      preferred_name: takeText(
        userProfileRaw.preferred_name,
        IMPORT_LIMITS.maxNameLength,
        'user_profile.preferred_name',
        collector
      ),
      facts: takeList(userProfileRaw.facts, 'user_profile.facts', collector),
      preferences: takeList(userProfileRaw.preferences, 'user_profile.preferences', collector),
      boundaries: takeList(userProfileRaw.boundaries, 'user_profile.boundaries', collector)
    },
    relationship: {
      summary,
      stage: takeText(
        relationshipRaw.stage,
        IMPORT_LIMITS.maxStageLength,
        'relationship.stage',
        collector
      ),
      interaction_patterns: takeList(
        relationshipRaw.interaction_patterns,
        'relationship.interaction_patterns',
        collector
      )
    },
    memories,
    unfinished_threads: takeList(
      payload.unfinished_threads,
      'unfinished_threads',
      collector
    ),
    uncertain_items: uncertainItems,
    source_metadata: {
      source_platform: takeText(
        sourceRaw.source_platform,
        IMPORT_LIMITS.maxShortItemLength,
        'source_metadata.source_platform',
        collector
      ),
      character_name_on_source: takeText(
        sourceRaw.character_name_on_source,
        IMPORT_LIMITS.maxNameLength,
        'source_metadata.character_name_on_source',
        collector
      ),
      processed_at: takeText(
        sourceRaw.processed_at,
        IMPORT_LIMITS.maxShortItemLength,
        'source_metadata.processed_at',
        collector
      ),
      notes: takeText(
        sourceRaw.notes,
        IMPORT_LIMITS.maxNotesLength,
        'source_metadata.notes',
        collector
      )
    }
  };

  if (uncertainItems.length > 0) {
    collector.add(
      'INFO',
      'UNCERTAIN_ITEMS_PRESENT',
      'uncertain_items',
      `有 ${uncertainItems.length} 条不确定信息，默认不会写入正式记忆。`
    );
  }
  if (memories.length === 0) {
    collector.add('INFO', 'NO_MEMORIES', 'memories', '这份数据没有可导入的长期记忆。');
  }
  if (collector.unknownFields.length > 0) {
    collector.add(
      'INFO',
      'UNKNOWN_FIELDS_PRESERVED',
      '',
      `有 ${collector.unknownFields.length} 个未知字段不会参与导入，但会保留在迁移记录中。`
    );
  }

  const ok = !collector.hasFatal();
  return {
    ok,
    issues: collector.issues,
    data: ok ? data : null,
    unknown_fields: collector.unknownFields
  };
}

export interface ParseResult {
  ok: boolean;
  value: unknown;
  issue?: ImportIssue;
}

/** Parses the raw text with an explicit byte cap and a readable JSON error. */
export function parseRelationshipImportText(text: string): ParseResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > IMPORT_LIMITS.maxPayloadBytes) {
    return {
      ok: false,
      value: null,
      issue: {
        severity: 'FATAL',
        code: 'PAYLOAD_TOO_LARGE',
        path: '',
        message: `导入内容为 ${Math.round(bytes / 1024)} KB，超过 ${
          IMPORT_LIMITS.maxPayloadBytes / 1024
        } KB 上限。`
      }
    };
  }
  if (!text.trim()) {
    return {
      ok: false,
      value: null,
      issue: {
        severity: 'FATAL',
        code: 'PAYLOAD_EMPTY',
        path: '',
        message: '导入内容为空，请粘贴整理后的 JSON。'
      }
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知解析错误';
    return {
      ok: false,
      value: null,
      issue: {
        severity: 'FATAL',
        code: 'PAYLOAD_NOT_JSON',
        path: '',
        message: `这段内容不是合法 JSON：${detail}。请确认外部模型只输出了 JSON，没有 Markdown 代码块或额外说明文字。`
      }
    };
  }
}

/**
 * agent_memory.importance is a 1–5 scale shared with the rest of the product; the
 * import format authors 1–10. The original value stays in the migration record.
 */
export function toAgentMemoryImportance(importance: number): number {
  return Math.min(5, Math.max(1, Math.ceil(importance / 2)));
}

/** `YYYY` / `YYYY-MM` / `YYYY-MM-DD` → an ISO instant usable for valid_from. */
export function approximateTimeToTimestamp(value: string | null): string | null {
  if (!value) return null;
  const match = APPROXIMATE_TIME_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month ?? '01'}-${day ?? '01'}T00:00:00.000Z`;
}
