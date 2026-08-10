import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCardFile } from './card-file';
import {
  buildLocalCharacterExport,
  storeImportedCardExtensions
} from './local-card-assets';
import { saveLocalCharacter } from './character-card';
import { resetChatRepositoryForTests } from './chat-repository';
import { resetLoreDatabaseForTests } from './lore-store';

afterEach(async () => {
  vi.restoreAllMocks();
  await resetLoreDatabaseForTests();
  await resetChatRepositoryForTests();
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
    await saveLocalCharacter({
      partition: 'guest',
      characterId: 'character-1',
      model: {
        name: '星遥', description: '电台主播', personality: '', scenario: '',
        first_message: '', alternate_greetings: [], example_messages: '',
        system_prompt: '', post_history_instructions: '', tags: [],
        creator: { name: '', notes: '', character_version: '' }
      },
      detail: {
        normalized_data: {
          name: '星遥', description: '电台主播', personality: '', scenario: '',
          first_message: '', alternate_greetings: [], example_messages: '',
          system_prompt: '', post_history_instructions: '', tags: [],
          creator: { name: '', notes: '', character_version: '' }
        },
        raw_data: source,
        source_metadata: {
          compatibility_level: 'FORMAL', format: 'CCV3_JSON', container: 'JSON',
          unapplied_fields: []
        },
        warnings: []
      }
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await buildLocalCharacterExport('guest', 'character-1');
    const card = await readCardFile(result.blob);
    expect(result.filename).toBe('litetavern-character-character-1.json');
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
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
