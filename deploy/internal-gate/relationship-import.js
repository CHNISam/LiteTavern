export const RELATIONSHIP_IMPORT_SCHEMA_VERSION = 'litetavern_relationship_import_v1';

const TOP_LEVEL_FIELDS = new Set([
  'schema_version', 'character', 'user_profile', 'relationship', 'memories',
  'unfinished_threads', 'uncertain_items', 'source_metadata'
]);
const CHARACTER_FIELDS = new Set(['name', 'description', 'personality_traits', 'speaking_style']);
const USER_PROFILE_FIELDS = new Set(['preferred_name', 'facts', 'preferences', 'boundaries']);
const RELATIONSHIP_FIELDS = new Set([
  'summary', 'stage', 'user_addressing', 'interaction_patterns'
]);
const MEMORY_FIELDS = new Set([
  'content', 'importance', 'approximate_time', 'tags', 'evidence_summary'
]);
const UNCERTAIN_FIELDS = new Set(['content', 'reason']);
const SOURCE_FIELDS = new Set([
  'source_platform', 'character_name_on_source', 'processed_at', 'notes'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(issues, severity, code, path, message) {
  issues.push({ severity, code, path, message });
}

function objectAt(value, path, issues) {
  if (isRecord(value)) return value;
  issue(issues, 'FATAL', 'TYPE_INVALID', path, '必须是 JSON 对象。');
  return {};
}

function unknownFields(value, allowed, path, issues, result) {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    const fieldPath = path ? `${path}.${key}` : key;
    result.push(fieldPath);
    issue(issues, 'FATAL', 'UNKNOWN_FIELD', fieldPath, '包含 Schema 未定义的字段。');
  }
}

function textAt(value, path, issues, { required = true, maxLength = 20_000 } = {}) {
  if (typeof value !== 'string') {
    if (!required && value === undefined) return '';
    issue(issues, 'FATAL', 'TYPE_INVALID', path, '必须是字符串。');
    return '';
  }
  const result = value.trim();
  if (result.length > maxLength) {
    issue(issues, 'FATAL', 'VALUE_TOO_LONG', path, `不能超过 ${maxLength} 个字符。`);
  }
  return result;
}

function stringsAt(value, path, issues, { required = true, maxItems = 200 } = {}) {
  if (!Array.isArray(value)) {
    if (!required && value === undefined) return [];
    issue(issues, 'FATAL', 'TYPE_INVALID', path, '必须是字符串数组。');
    return [];
  }
  if (value.length > maxItems) {
    issue(issues, 'FATAL', 'TOO_MANY_ITEMS', path, `不能超过 ${maxItems} 项。`);
  }
  const result = [];
  const seen = new Set();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      issue(issues, 'FATAL', 'TYPE_INVALID', `${path}[${index}]`, '必须是字符串。');
      return;
    }
    const normalized = entry.trim();
    const key = normalized.toLocaleLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  });
  return result;
}

function canonicalMemory(content) {
  return content.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function validateRelationshipImportText(rawText) {
  const issues = [];
  const unknown = [];
  let parsed;
  try {
    parsed = JSON.parse(typeof rawText === 'string' ? rawText : '');
  } catch {
    return {
      valid: false,
      preview: null,
      unknown_fields: [],
      issues: [{
        severity: 'FATAL',
        code: 'INVALID_JSON',
        path: '',
        message: '输出必须只包含一个合法 JSON 对象，不能带 Markdown 或额外说明。'
      }]
    };
  }

  const root = objectAt(parsed, '', issues);
  unknownFields(root, TOP_LEVEL_FIELDS, '', issues, unknown);
  if (root.schema_version !== RELATIONSHIP_IMPORT_SCHEMA_VERSION) {
    issue(
      issues,
      'FATAL',
      'SCHEMA_VERSION_UNSUPPORTED',
      'schema_version',
      '不支持的 schema_version。'
    );
  }

  const character = objectAt(root.character, 'character', issues);
  unknownFields(character, CHARACTER_FIELDS, 'character', issues, unknown);
  const userProfile = objectAt(root.user_profile, 'user_profile', issues);
  unknownFields(userProfile, USER_PROFILE_FIELDS, 'user_profile', issues, unknown);
  const relationship = objectAt(root.relationship, 'relationship', issues);
  unknownFields(relationship, RELATIONSHIP_FIELDS, 'relationship', issues, unknown);
  const sourceMetadata = objectAt(root.source_metadata, 'source_metadata', issues);
  unknownFields(sourceMetadata, SOURCE_FIELDS, 'source_metadata', issues, unknown);

  const normalizedCharacter = {
    name: textAt(character.name, 'character.name', issues),
    description: textAt(character.description, 'character.description', issues),
    personality_traits: stringsAt(
      character.personality_traits,
      'character.personality_traits',
      issues
    ),
    speaking_style: stringsAt(character.speaking_style, 'character.speaking_style', issues)
  };
  const normalizedUserProfile = {
    preferred_name: textAt(userProfile.preferred_name, 'user_profile.preferred_name', issues),
    facts: stringsAt(userProfile.facts, 'user_profile.facts', issues),
    preferences: stringsAt(userProfile.preferences, 'user_profile.preferences', issues),
    boundaries: stringsAt(userProfile.boundaries, 'user_profile.boundaries', issues)
  };
  const normalizedRelationship = {
    summary: textAt(relationship.summary, 'relationship.summary', issues),
    stage: textAt(relationship.stage, 'relationship.stage', issues),
    // v1 originally omitted this field, so absence is the one intentional
    // structural compatibility exception.
    user_addressing: stringsAt(
      relationship.user_addressing,
      'relationship.user_addressing',
      issues,
      { required: false }
    ),
    interaction_patterns: stringsAt(
      relationship.interaction_patterns,
      'relationship.interaction_patterns',
      issues
    )
  };

  const rawMemories = Array.isArray(root.memories) ? root.memories : [];
  if (!Array.isArray(root.memories)) {
    issue(issues, 'FATAL', 'TYPE_INVALID', 'memories', '必须是记忆数组。');
  }
  if (rawMemories.length > 500) {
    issue(issues, 'FATAL', 'TOO_MANY_ITEMS', 'memories', '不能超过 500 条。');
  }
  const memoryKeys = new Map();
  const memories = [];
  let duplicateMemories = 0;
  rawMemories.forEach((entry, index) => {
    const path = `memories[${index}]`;
    const memory = objectAt(entry, path, issues);
    unknownFields(memory, MEMORY_FIELDS, path, issues, unknown);
    const content = textAt(memory.content, `${path}.content`, issues);
    if (!content) {
      issue(issues, 'FATAL', 'VALUE_REQUIRED', `${path}.content`, '记忆内容不能为空。');
    }
    if (!Number.isInteger(memory.importance) || memory.importance < 1 || memory.importance > 10) {
      issue(issues, 'FATAL', 'VALUE_INVALID', `${path}.importance`, '必须是 1 到 10 的整数。');
    }
    let approximateTime = null;
    if (memory.approximate_time !== null) {
      approximateTime = textAt(memory.approximate_time, `${path}.approximate_time`, issues);
    }
    const normalized = {
      key: `m${memories.length}`,
      content,
      importance: Number.isInteger(memory.importance) ? memory.importance : 1,
      approximate_time: approximateTime,
      tags: stringsAt(memory.tags, `${path}.tags`, issues),
      evidence_summary: textAt(memory.evidence_summary, `${path}.evidence_summary`, issues)
    };
    const canonical = canonicalMemory(content);
    if (canonical && memoryKeys.has(canonical)) {
      duplicateMemories += 1;
      return;
    }
    memoryKeys.set(canonical, normalized.key);
    memories.push(normalized);
  });

  const rawUncertain = Array.isArray(root.uncertain_items) ? root.uncertain_items : [];
  if (!Array.isArray(root.uncertain_items)) {
    issue(issues, 'FATAL', 'TYPE_INVALID', 'uncertain_items', '必须是不确定信息数组。');
  }
  const uncertainItems = rawUncertain.map((entry, index) => {
    const path = `uncertain_items[${index}]`;
    const item = objectAt(entry, path, issues);
    unknownFields(item, UNCERTAIN_FIELDS, path, issues, unknown);
    return {
      content: textAt(item.content, `${path}.content`, issues),
      reason: textAt(item.reason, `${path}.reason`, issues)
    };
  });

  if (sourceMetadata.processed_at !== null) {
    issue(
      issues,
      'FATAL',
      'PROCESSED_AT_MODEL_OWNED',
      'source_metadata.processed_at',
      '模型输出中的 processed_at 必须为 null。'
    );
  }
  const normalizedSourceMetadata = {
    source_platform: textAt(
      sourceMetadata.source_platform,
      'source_metadata.source_platform',
      issues
    ),
    character_name_on_source: textAt(
      sourceMetadata.character_name_on_source,
      'source_metadata.character_name_on_source',
      issues
    ),
    processed_at: null,
    notes: textAt(sourceMetadata.notes, 'source_metadata.notes', issues)
  };

  const preview = {
    schema_version: RELATIONSHIP_IMPORT_SCHEMA_VERSION,
    character: normalizedCharacter,
    user_profile: normalizedUserProfile,
    relationship: normalizedRelationship,
    memories,
    unfinished_threads: stringsAt(root.unfinished_threads, 'unfinished_threads', issues),
    uncertain_items: uncertainItems,
    source_metadata: normalizedSourceMetadata,
    counts: {
      memories: memories.length,
      uncertain_items: uncertainItems.length,
      unfinished_threads: Array.isArray(root.unfinished_threads)
        ? root.unfinished_threads.length
        : 0,
      duplicate_memories: duplicateMemories
    }
  };

  return {
    valid: !issues.some((entry) => entry.severity === 'FATAL'),
    preview,
    unknown_fields: [...new Set(unknown)],
    issues
  };
}

export function importPayloadFromPreview(preview) {
  return {
    schema_version: preview.schema_version,
    character: preview.character,
    user_profile: preview.user_profile,
    relationship: preview.relationship,
    memories: preview.memories.map((memory) => ({
      content: memory.content,
      importance: memory.importance,
      approximate_time: memory.approximate_time,
      tags: memory.tags,
      evidence_summary: memory.evidence_summary
    })),
    unfinished_threads: preview.unfinished_threads,
    uncertain_items: preview.uncertain_items,
    source_metadata: preview.source_metadata
  };
}
