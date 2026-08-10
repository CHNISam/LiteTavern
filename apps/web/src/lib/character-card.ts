import { chatRepository } from './chat-repository';
import { createId } from './id';
import { cloneJson } from './json-clone';

/**
 * The editable character card.
 *
 * `description` and `personality` are stored verbatim as the character's
 * `profile_summary` and `personality_summary`, which is what the profile shows —
 * so editing either field on the profile is editing the card, not some derived
 * copy that would drift away from it.
 */
export interface CharacterModel {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_message: string;
  alternate_greetings: string[];
  example_messages: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  creator: {
    name: string;
    notes: string;
    character_version: string;
  };
}

export interface CardDetail {
  normalized_data: CharacterModel;
  /** Original card payload retained for lossless browser-local export. */
  raw_data?: Record<string, unknown>;
  source_metadata: {
    compatibility_level: 'FORMAL' | 'COMPATIBLE' | 'PRESERVED';
    format: string;
    container: string;
    unapplied_fields: string[];
  };
  warnings: string[];
}

export const EMPTY_CHARACTER: CharacterModel = {
  name: '',
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
};

export async function fetchCharacterCard(
  partition: string,
  characterId: string
): Promise<CardDetail> {
  const character = await chatRepository.getCharacter(partition, characterId);
  if (!character?.local_card) throw new Error('Character card is not available locally.');
  return cloneJson(character.local_card);
}

const LOCAL_SOURCE: CardDetail['source_metadata'] = {
  compatibility_level: 'FORMAL', format: 'LOCAL_V1', container: 'INDEXED_DB',
  unapplied_fields: []
};

function cardText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof record[key] === 'string') return record[key] as string;
  return '';
}

export function characterModelFromCard(card: Record<string, unknown>): CharacterModel {
  const data = card.data && typeof card.data === 'object'
    ? card.data as Record<string, unknown> : card;
  const creator = data.creator && typeof data.creator === 'object'
    ? data.creator as Record<string, unknown> : {};
  return {
    ...EMPTY_CHARACTER,
    name: cardText(data, 'name', 'char_name'),
    description: cardText(data, 'description', 'char_persona'),
    personality: cardText(data, 'personality'),
    scenario: cardText(data, 'scenario', 'world_scenario'),
    first_message: cardText(data, 'first_mes', 'first_message', 'char_greeting'),
    alternate_greetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.filter((value): value is string => typeof value === 'string') : [],
    example_messages: cardText(data, 'mes_example', 'example_messages', 'example_dialogue'),
    system_prompt: cardText(data, 'system_prompt'),
    post_history_instructions: cardText(data, 'post_history_instructions'),
    tags: Array.isArray(data.tags)
      ? data.tags.filter((value): value is string => typeof value === 'string') : [],
    creator: {
      name: cardText(data, 'creator') || cardText(creator, 'name'),
      notes: cardText(data, 'creator_notes') || cardText(creator, 'notes'),
      character_version: cardText(data, 'character_version') || cardText(creator, 'character_version')
    }
  };
}

export async function saveLocalCharacter(input: {
  partition: string;
  model: CharacterModel;
  characterId?: string;
  avatarDataUrl?: string | null;
  detail?: CardDetail | null;
}): Promise<string> {
  const characterId = input.characterId ?? createId();
  const previous = await chatRepository.getCharacter(input.partition, characterId);
  const detail: CardDetail = input.detail
    ? { ...input.detail, normalized_data: cloneJson(input.model) }
    : { normalized_data: cloneJson(input.model), source_metadata: LOCAL_SOURCE, warnings: [] };
  await chatRepository.putCharacter(input.partition, {
    ...(previous ?? {}),
    character_id: characterId,
    name: input.model.name.trim(),
    profile_summary: input.model.description,
    personality_summary: input.model.personality,
    first_message: input.model.first_message,
    avatar_seed: input.avatarDataUrl === null
      ? characterId
      : input.avatarDataUrl ?? previous?.avatar_seed ?? characterId,
    version: (previous?.version ?? 0) + 1,
    is_owned: true,
    local_card: detail
  });
  return characterId;
}

/**
 * Changes one part of a card without disturbing the rest.
 *
 * The card endpoint replaces the whole document, so the current card is read
 * first and the patch merged onto it. Editing a field inline must never drop the
 * advanced fields the reader cannot see from where they are standing.
 */
export async function patchCharacterCard(
  partition: string,
  characterId: string,
  patch: Partial<CharacterModel>
): Promise<void> {
  const current = await fetchCharacterCard(partition, characterId);
  await saveLocalCharacter({ partition, characterId,
    model: { ...current.normalized_data, ...patch }, detail: current });
}
