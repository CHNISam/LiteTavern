import { describe, expect, it } from 'vitest';
import {
  CharacterCardAdapterRegistry,
  exportCharacterCard,
  exportNormalizedCharacterCard,
  parseCharacterCard,
  type CharacterCardAdapter
} from './adapter.js';

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '星遥',
    description: '来自海边城市的电台主播。',
    personality: '温柔，敏锐，不轻易打断别人。',
    scenario: '深夜电台节目结束后。',
    first_mes: '这么晚还没睡吗？',
    mes_example: '<START>\n{{char}}: 今晚想听什么？',
    alternate_greetings: ['欢迎回来。'],
    system_prompt: '保持自然、克制。',
    post_history_instructions: '不要替用户做决定。',
    creator_notes: '测试角色卡',
    tags: ['电台'],
    creator: 'PomChat Test',
    character_version: '1.2',
    extensions: { pomchat_test: true }
  },
  future_field: 'must survive'
};

const v3 = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '时雨',
    description: '旅行摄影师。',
    personality: '安静而好奇。',
    first_mes: '要看看我今天拍的云吗？'
  }
};

describe('character card adapter', () => {
  it('normalizes CCv2 JSON and preserves unknown fields', () => {
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(v2)));
    expect(parsed.format).toBe('CCV2_JSON');
    expect(parsed.character).toMatchObject({ name: '星遥', firstMessage: '这么晚还没睡吗？' });
    expect(parsed.normalizedData).toMatchObject({
      name: '星遥',
      scenario: '深夜电台节目结束后。',
      first_message: '这么晚还没睡吗？',
      alternate_greetings: ['欢迎回来。'],
      example_messages: '<START>\n{{char}}: 今晚想听什么？',
      creator: {
        name: 'PomChat Test',
        notes: '测试角色卡',
        character_version: '1.2'
      }
    });
    expect(parsed.passthroughData).toEqual({
      root: { future_field: 'must survive' },
      data: { extensions: { pomchat_test: true } }
    });
    expect(parsed.sourceMetadata).toMatchObject({
      format: 'CHARACTER_CARD_V2',
      container: 'JSON',
      spec_version: '2.0',
      compatibility_level: 'FORMAL'
    });
    expect(parsed.sourceMetadata.unapplied_fields).toEqual(
      expect.arrayContaining(['data.alternate_greetings', 'data.extensions'])
    );
  });

  it('round-trips CCv3 PNG and prefers ccv3 over a legacy chara chunk', () => {
    const png = exportCharacterCard(v3, 'CCV3_PNG', {
      extraTextChunks: { chara: Buffer.from(JSON.stringify(v2)).toString('base64') }
    });
    const parsed = parseCharacterCard(png);
    expect(parsed.format).toBe('CCV3_PNG');
    expect(parsed.character.name).toBe('时雨');
    expect(parsed.source.spec).toBe('chara_card_v3');
  });

  it('uses safe defaults for missing optional fields and rejects mapped type errors', () => {
    const minimal = parseCharacterCard(Buffer.from(JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '最小角色' }
    })));
    expect(minimal.normalizedData).toMatchObject({
      name: '最小角色',
      description: '',
      personality: '',
      scenario: '',
      first_message: '',
      alternate_greetings: [],
      tags: []
    });

    expect(() => parseCharacterCard(Buffer.from(JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '错误角色', alternate_greetings: '不是数组' }
    })))).toThrow('CHARACTER_CARD_INVALID');
  });

  it('compatibly imports flat Tavern Card V1 based on structure, not a filename', () => {
    const v1 = {
      name: '旧卡角色',
      description: '扁平结构',
      personality: '谨慎',
      scenario: '旧酒馆',
      first_mes: '欢迎。',
      mes_example: '{{char}}: 请坐。',
      vendor_field: { keep: true }
    };
    const parsed = parseCharacterCard(Buffer.from(JSON.stringify(v1)));
    expect(parsed.format).toBe('CCV1_JSON');
    expect(parsed.normalizedData.scenario).toBe('旧酒馆');
    expect(parsed.passthroughData.root).toMatchObject({ vendor_field: { keep: true } });
    expect(parsed.sourceMetadata.compatibility_level).toBe('COMPATIBLE');
  });

  it('can add a new format by registering an adapter without changing the import core', () => {
    const fakeAdapter: CharacterCardAdapter = {
      id: 'test/fake',
      detect(source) {
        return source.toString('utf8').startsWith('FAKE:') ? { score: 100, container: 'JSON' } : null;
      },
      parse() {
        return {
          format: 'CCV3_JSON',
          specVersion: '3.0',
          normalizedData: {
            name: '注册角色',
            description: '',
            personality: '',
            scenario: '',
            first_message: '',
            alternate_greetings: [],
            example_messages: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: { name: '', notes: '', character_version: '' }
          },
          passthroughData: { root: {}, data: {} },
          sourceMetadata: {
            format: 'CHARACTER_CARD_V3',
            container: 'JSON',
            spec_version: '3.0',
            compatibility_level: 'FORMAL',
            parser_id: 'test/fake',
            parser_version: '1',
            unapplied_fields: []
          },
          warnings: [],
          source: { fake: true }
        };
      },
      export() {
        return Buffer.from('FAKE:exported');
      }
    };
    const registry = new CharacterCardAdapterRegistry([fakeAdapter]);
    expect(registry.parse(Buffer.from('FAKE:card')).normalizedData.name).toBe('注册角色');
  });

  it('overlays edited supported fields while retaining unknown JSON and PNG data', () => {
    const imported = parseCharacterCard(exportCharacterCard(v3, 'CCV3_PNG', {
      extraTextChunks: { vendor: 'opaque-metadata' }
    }));
    const edited = {
      ...imported.normalizedData,
      name: '修改后的名字'
    };
    const output = exportNormalizedCharacterCard(
      edited,
      imported.passthroughData,
      'CCV3_PNG',
      { basePng: exportCharacterCard(v3, 'CCV3_PNG', { extraTextChunks: { vendor: 'opaque-metadata' } }) }
    );
    const roundTrip = parseCharacterCard(output);
    expect(roundTrip.normalizedData.name).toBe('修改后的名字');
    expect(output.includes(Buffer.from('vendor'))).toBe(true);
  });

  it('rejects corrupted and unsupported input without trusting the extension', () => {
    expect(() => parseCharacterCard(Buffer.from('not a card'))).toThrow('CHARACTER_CARD_INVALID');
    expect(() => parseCharacterCard(Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(
      'CHARACTER_CARD_TOO_LARGE'
    );
  });
});
