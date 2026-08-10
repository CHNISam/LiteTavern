import {
  embeddedCharacterBook,
  embeddedRegexScripts,
  rewriteCardFile
} from './card-file';
import { fetchCharacterCard } from './character-card';
import { t } from './i18n';
import {
  regexScriptsForExport,
  saveCharacterRegexBundle
} from './regex-engine';
import {
  characterCardWorldbook,
  exportWorldbook,
  replaceCharacterCardWorldbook
} from './worldbook';

export async function storeImportedCardExtensions(
  cardData: Record<string, unknown>,
  characterId: string,
  characterName: string,
  authorizeRegex: boolean
): Promise<void> {
  await replaceCharacterCardWorldbook(
    characterId,
    embeddedCharacterBook(cardData),
    t().localAssets.characterWorldbookName(characterName)
  );
  await saveCharacterRegexBundle(
    characterId,
    embeddedRegexScripts(cardData),
    authorizeRegex
  );
}

export async function buildLocalCharacterExport(
  partition: string,
  characterId: string
): Promise<{ blob: Blob; filename: string }> {
  const detail = await fetchCharacterCard(partition, characterId);
  const model = detail.normalized_data;
  const card = detail.raw_data ?? {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: model.name,
      description: model.description,
      personality: model.personality,
      scenario: model.scenario,
      first_mes: model.first_message,
      alternate_greetings: model.alternate_greetings,
      mes_example: model.example_messages,
      system_prompt: model.system_prompt,
      post_history_instructions: model.post_history_instructions,
      tags: model.tags,
      creator: model.creator.name,
      creator_notes: model.creator.notes,
      character_version: model.creator.character_version
    }
  };
  const base = new Blob([JSON.stringify(card)], { type: 'application/json' });
  const localBook = await characterCardWorldbook(characterId);
  const characterBook = localBook
    ? await exportWorldbook(localBook.worldbook_id)
    : embeddedCharacterBook(card);
  const regexScripts = await regexScriptsForExport(characterId);
  const blob = await rewriteCardFile(base, characterBook, regexScripts);
  return {
    blob,
    filename: `litetavern-character-${characterId}.json`
  };
}

export function downloadLocalCharacterExport(
  result: { blob: Blob; filename: string }
): void {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.filename;
  link.click();
  URL.revokeObjectURL(url);
}
