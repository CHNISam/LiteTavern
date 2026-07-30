import { api } from './api';
import { isFeatureUnavailable } from './persona';

export type WorldbookPosition = 'BEFORE_CHAR' | 'AFTER_CHAR';
export type SelectiveLogic = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL';

export interface Worldbook {
  worldbook_id: string;
  name: string;
  description: string;
  enabled: boolean;
  scan_depth: number | null;
  token_budget: number | null;
  origin: 'USER' | 'CHARACTER_BOOK';
  entry_count: number;
}

export interface WorldbookEntry {
  entry_id: string;
  worldbook_id: string;
  title: string;
  content: string;
  keys: string[];
  selective: boolean;
  secondary_keys: string[];
  selective_logic: SelectiveLogic;
  constant: boolean;
  enabled: boolean;
  case_sensitive: boolean;
  match_whole_words: boolean;
  position: WorldbookPosition;
  insertion_order: number;
  priority: number | null;
}

export interface CharacterWorldbookLink {
  worldbook_id: string;
  name: string;
  enabled: boolean;
  link_enabled: boolean;
  entry_count: number;
  origin: 'USER' | 'CHARACTER_BOOK';
}

export type WorldbookEntryDraft = Pick<
  WorldbookEntry,
  'title' | 'content' | 'keys' | 'constant' | 'enabled' | 'position' | 'insertion_order'
>;

/** `null` means this deployment has no worldbook API, not "no worldbooks". */
export async function listWorldbooks(): Promise<Worldbook[] | null> {
  try {
    const response = await api<{ worldbooks: Worldbook[] }>('/v1/worldbooks');
    return response.worldbooks;
  } catch (reason) {
    if (isFeatureUnavailable(reason)) return null;
    throw reason;
  }
}

export async function readWorldbook(
  worldbookId: string
): Promise<{ worldbook: Worldbook; entries: WorldbookEntry[] }> {
  return api(`/v1/worldbooks/${worldbookId}`);
}

export async function createWorldbook(name: string): Promise<string> {
  const response = await api<{ worldbook_id: string }>('/v1/worldbooks', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  return response.worldbook_id;
}

export async function updateWorldbook(
  worldbookId: string,
  patch: Partial<Pick<Worldbook, 'name' | 'description' | 'enabled'>>
): Promise<void> {
  await api(`/v1/worldbooks/${worldbookId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

export async function deleteWorldbook(worldbookId: string): Promise<void> {
  await api(`/v1/worldbooks/${worldbookId}`, { method: 'DELETE' });
}

export async function createWorldbookEntry(
  worldbookId: string,
  draft: WorldbookEntryDraft
): Promise<void> {
  await api(`/v1/worldbooks/${worldbookId}/entries`, {
    method: 'POST',
    body: JSON.stringify(draft)
  });
}

export async function updateWorldbookEntry(
  entryId: string,
  patch: Partial<WorldbookEntryDraft>
): Promise<void> {
  await api(`/v1/worldbook-entries/${entryId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

export async function deleteWorldbookEntry(entryId: string): Promise<void> {
  await api(`/v1/worldbook-entries/${entryId}`, { method: 'DELETE' });
}

export async function listCharacterWorldbooks(
  characterId: string
): Promise<CharacterWorldbookLink[] | null> {
  try {
    const response = await api<{ worldbooks: CharacterWorldbookLink[] }>(
      `/v1/characters/${characterId}/worldbooks`
    );
    return response.worldbooks;
  } catch (reason) {
    if (isFeatureUnavailable(reason)) return null;
    throw reason;
  }
}

/** Send the desired end state, so repeating the request changes nothing. */
export async function setCharacterWorldbooks(
  characterId: string,
  worldbooks: { worldbook_id: string; enabled?: boolean }[]
): Promise<CharacterWorldbookLink[]> {
  const response = await api<{ worldbooks: CharacterWorldbookLink[] }>(
    `/v1/characters/${characterId}/worldbooks`,
    { method: 'PUT', body: JSON.stringify({ worldbooks }) }
  );
  return response.worldbooks;
}
