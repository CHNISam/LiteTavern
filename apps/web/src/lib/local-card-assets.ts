import {
  embeddedCharacterBook,
  embeddedRegexScripts,
  readCardFile,
  rewriteCardFile
} from './card-file';
import { readApiJson } from './api';
import {
  regexScriptsForExport,
  saveCharacterRegexBundle
} from './regex-engine';
import { cloudUrl } from './runtime-config';
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
    `${characterName}的角色世界书`
  );
  await saveCharacterRegexBundle(
    characterId,
    embeddedRegexScripts(cardData),
    authorizeRegex
  );
}

export async function buildLocalCharacterExport(
  characterId: string
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(
    cloudUrl(
      `/v1/characters/${characterId}/export?asset_mode=LOCAL_EXTENSIONS_V1`
    ),
    { credentials: 'include' }
  );
  if (!response.ok) {
    const payload = await readApiJson<{ error?: { message?: string } }>(response);
    throw new Error(payload.error?.message ?? '角色卡导出失败。');
  }
  const base = await response.blob();
  const card = await readCardFile(base);
  if (!card) throw new Error('Cloud 返回的角色卡无法读取。');
  const localBook = await characterCardWorldbook(characterId);
  const characterBook = localBook
    ? await exportWorldbook(localBook.worldbook_id)
    : embeddedCharacterBook(card);
  const regexScripts = await regexScriptsForExport(characterId);
  const blob = await rewriteCardFile(base, characterBook, regexScripts);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const matched = disposition.match(/filename="?([^";]+)"?/i);
  const extension = blob.type === 'image/png' ? 'png' : 'json';
  return {
    blob,
    filename:
      matched?.[1] ?? `litetavern-character-${characterId}.${extension}`
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
