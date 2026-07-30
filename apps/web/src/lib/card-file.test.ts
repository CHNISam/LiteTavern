import { describe, expect, it } from 'vitest';
import {
  cardDataFromPngChunks,
  embeddedCharacterBook,
  embeddedRegexScripts
} from './card-file';

function encoded(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('local character-card inspection', () => {
  it('prefers ccv3 metadata when a PNG also carries a chara chunk', () => {
    expect(
      cardDataFromPngChunks({
        chara: encoded({ spec: 'chara_card_v2', data: { name: 'V2' } }),
        ccv3: encoded({ spec: 'chara_card_v3', data: { name: 'V3' } })
      })
    ).toMatchObject({ spec: 'chara_card_v3', data: { name: 'V3' } });
  });

  it('finds embedded Character Book and scoped Regex scripts', () => {
    const card = {
      data: {
        character_book: { entries: [{ keys: ['港口'], content: '白港。' }] },
        extensions: {
          regex_scripts: [{
            id: 'cleanup',
            findRegex: '/<think>.*?<\\/think>/gs',
            replaceString: '',
            placement: [2]
          }]
        }
      }
    };
    expect(embeddedCharacterBook(card)).toMatchObject({ entries: expect.any(Array) });
    expect(embeddedRegexScripts(card)).toHaveLength(1);
  });
});
