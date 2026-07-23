import { describe, expect, it } from 'vitest';
import { exportCharacterCard, parseCharacterCard } from './adapter.js';

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '星遥',
    description: '来自海边城市的电台主播。',
    personality: '温柔，敏锐，不轻易打断别人。',
    first_mes: '这么晚还没睡吗？',
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
    expect(parsed.preserved).toMatchObject({ future_field: 'must survive' });
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

  it('rejects corrupted and unsupported input without trusting the extension', () => {
    expect(() => parseCharacterCard(Buffer.from('not a card'))).toThrow('CHARACTER_CARD_INVALID');
    expect(() => parseCharacterCard(Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(
      'CHARACTER_CARD_TOO_LARGE'
    );
  });
});
