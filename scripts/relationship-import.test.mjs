import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELATIONSHIP_IMPORT_SCHEMA_VERSION,
  validateRelationshipImportText
} from '../deploy/internal-gate/relationship-import.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'relationship-import',
  'litetavern_relationship_import_mock_pack'
);

function fixtureJson(relativePath) {
  return JSON.parse(readFileSync(join(fixtureRoot, relativePath), 'utf8'));
}

function payload(overrides = {}) {
  return {
    schema_version: RELATIONSHIP_IMPORT_SCHEMA_VERSION,
    character: {
      name: '林岚',
      description: '虚构的夜间电台主持人',
      personality_traits: ['耐心'],
      speaking_style: ['语气简洁']
    },
    user_profile: {
      preferred_name: '小舟',
      facts: ['从事插画工作'],
      preferences: ['喜欢雨声'],
      boundaries: []
    },
    relationship: {
      summary: '两人从普通听众与主持人发展为会彼此关心的朋友。',
      stage: '亲密朋友',
      user_addressing: ['小舟'],
      interaction_patterns: ['睡前互道晚安']
    },
    memories: [{
      content: '两人一起听完了虚构节目《夜航》的最后一期。',
      importance: 8,
      approximate_time: '2026-05',
      tags: ['共同经历'],
      evidence_summary: '双方在多条消息中回顾了最后一期节目。'
    }],
    unfinished_threads: ['约好下次一起整理歌单'],
    uncertain_items: [],
    source_metadata: {
      source_platform: 'fictional-chat',
      character_name_on_source: '林岚',
      processed_at: null,
      notes: ''
    },
    ...overrides
  };
}

test('accepts v1 data without user_addressing and normalizes it for backward compatibility', () => {
  const legacy = payload();
  delete legacy.relationship.user_addressing;
  const result = validateRelationshipImportText(JSON.stringify(legacy));

  assert.equal(result.valid, true);
  assert.deepEqual(result.preview.relationship.user_addressing, []);
});

test('deduplicates repeated memories without increasing importance', () => {
  const source = payload({
    memories: [
      payload().memories[0],
      { ...payload().memories[0], importance: 10 }
    ]
  });
  const result = validateRelationshipImportText(JSON.stringify(source));

  assert.equal(result.valid, true);
  assert.equal(result.preview.memories.length, 1);
  assert.equal(result.preview.memories[0].importance, 8);
  assert.equal(result.preview.counts.duplicate_memories, 1);
});

test('rejects Markdown wrappers or explanations around otherwise valid JSON', () => {
  for (const raw of [
    `\`\`\`json\n${JSON.stringify(payload())}\n\`\`\``,
    `迁移完成：${JSON.stringify(payload())}`,
    `${JSON.stringify(payload())}\n以上是导入结果。`
  ]) {
    const result = validateRelationshipImportText(raw);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === 'INVALID_JSON'));
  }
});

test('rejects model-invented processed_at, unknown fields and invalid memory values', () => {
  const invalid = payload({
    extra_explanation: 'done',
    source_metadata: { ...payload().source_metadata, processed_at: '2026-07-29T00:00:00Z' },
    memories: [{ ...payload().memories[0], importance: 11 }]
  });
  const result = validateRelationshipImportText(JSON.stringify(invalid));

  assert.equal(result.valid, false);
  assert.ok(result.unknown_fields.includes('extra_explanation'));
  assert.ok(result.issues.some((issue) => issue.path === 'source_metadata.processed_at'));
  assert.ok(result.issues.some((issue) => issue.path === 'memories[0].importance'));
});

test('allows missing platform and character names but keeps the values empty', () => {
  const source = payload({
    character: { ...payload().character, name: '' },
    source_metadata: {
      ...payload().source_metadata,
      source_platform: '',
      character_name_on_source: ''
    }
  });
  const result = validateRelationshipImportText(JSON.stringify(source));

  assert.equal(result.valid, true);
  assert.equal(result.preview.character.name, '');
  assert.equal(result.preview.source_metadata.source_platform, '');
});

test('the external mock pack has 12 declared inputs and five valid expected results', () => {
  const manifest = fixtureJson('manifest.json');
  assert.equal(manifest.fixtures.length, 12);
  const expectedFiles = new Set();
  for (const fixture of manifest.fixtures) {
    assert.equal(existsSync(join(fixtureRoot, fixture.file)), true, fixture.file);
    assert.equal(existsSync(join(fixtureRoot, fixture.expected)), true, fixture.expected);
    expectedFiles.add(fixture.expected);
  }
  assert.equal(expectedFiles.size, 5);

  for (const expectedFile of expectedFiles) {
    const raw = readFileSync(join(fixtureRoot, expectedFile), 'utf8');
    const result = validateRelationshipImportText(raw);
    assert.equal(result.valid, true, `${expectedFile}: ${JSON.stringify(result.issues)}`);
    assert.equal(result.preview.source_metadata.processed_at, null);
    assert.ok(Array.isArray(result.preview.relationship.user_addressing));
  }
});

test('the long noisy fixture contains 340 messages despite its legacy 320 filename', () => {
  const messages = fixtureJson('inputs/12_long_noisy_320_messages.json');
  assert.ok(Array.isArray(messages));
  assert.equal(messages.length, 340);
});

test('golden results preserve relationship changes, uncertainty and injection isolation', () => {
  const canonical = fixtureJson('expected/canonical_expected.json');
  assert.deepEqual(canonical.relationship.user_addressing, ['小舟']);
  assert.ok(canonical.user_profile.preferences.some((item) => item.includes('热牛奶')));
  assert.equal(canonical.user_profile.preferences.some((item) => item.includes('冰美式')), false);

  const conflict = fixtureJson('expected/conflict_expected.json');
  assert.match(conflict.relationship.summary, /早上七点.*取消.*下午三点/);
  assert.ok(conflict.uncertain_items.some((item) => item.content.includes('姐姐')));

  const injection = fixtureJson('expected/prompt_injection_expected.json');
  assert.equal(JSON.stringify(injection.character).includes('海盗'), false);
  assert.equal(JSON.stringify(injection).includes('SYSTEM 注入文本当作稳定设定'), true);
  assert.ok(injection.user_profile.boundaries.some((item) => item.includes('不希望被剧透')));

  const merged = fixtureJson('expected/batch_merge_expected.json');
  assert.equal(new Set(merged.memories.map((memory) => memory.content)).size, merged.memories.length);
  assert.ok(merged.uncertain_items.some((item) => item.content.includes('兄弟姐妹')));

  const missing = fixtureJson('expected/missing_names_expected.json');
  assert.equal(missing.character.name, '');
  assert.equal(missing.source_metadata.source_platform, '');
  assert.equal(missing.source_metadata.character_name_on_source, '');
});
