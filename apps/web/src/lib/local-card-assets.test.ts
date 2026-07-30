import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCardFile } from './card-file';
import {
  buildLocalCharacterExport,
  storeImportedCardExtensions
} from './local-card-assets';
import { resetLoreDatabaseForTests } from './lore-store';

afterEach(async () => {
  vi.restoreAllMocks();
  await resetLoreDatabaseForTests();
});

describe('local character-card extensions', () => {
  it('overlays the local character book and Regex bundle on Cloud card data', async () => {
    const source = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '星遥',
        description: '电台主播',
        extensions: { vendor: 'keep' },
        character_book: {
          name: '本地设定',
          entries: [
            {
              keys: ['电台'],
              content: '只在夜里开播。',
              enabled: true
            }
          ]
        }
      }
    };
    await storeImportedCardExtensions(
      {
        ...source,
        data: {
          ...source.data,
          extensions: {
            ...source.data.extensions,
            regex_scripts: [
              {
                id: 'cleanup',
                scriptName: '清理',
                findRegex: '/x/g',
                replaceString: 'y',
                placement: [2]
              }
            ]
          }
        }
      },
      'character-1',
      '星遥',
      false
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(source), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="star.json"'
        }
      })
    );

    const result = await buildLocalCharacterExport('character-1');
    const card = await readCardFile(result.blob);
    expect(result.filename).toBe('star.json');
    expect(card?.data).toMatchObject({
      extensions: {
        vendor: 'keep',
        regex_scripts: [
          expect.objectContaining({ scriptName: '清理', findRegex: '/x/g' })
        ]
      },
      character_book: {
        name: '本地设定',
        entries: [
          expect.objectContaining({
            keys: ['电台'],
            content: '只在夜里开播。'
          })
        ]
      }
    });
    expect(fetch).toHaveBeenCalledWith(
      '/v1/characters/character-1/export?asset_mode=LOCAL_EXTENSIONS_V1',
      { credentials: 'include' }
    );
  });
});
