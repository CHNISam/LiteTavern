import { api } from './api';

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

export function fetchCharacterCard(characterId: string): Promise<CardDetail> {
  return api<CardDetail>(`/v1/characters/${characterId}/card`);
}

/**
 * Changes one part of a card without disturbing the rest.
 *
 * The card endpoint replaces the whole document, so the current card is read
 * first and the patch merged onto it. Editing a field inline must never drop the
 * advanced fields the reader cannot see from where they are standing.
 */
export async function patchCharacterCard(
  characterId: string,
  patch: Partial<CharacterModel>
): Promise<void> {
  const current = await fetchCharacterCard(characterId);
  await api(`/v1/characters/${characterId}/card`, {
    method: 'PUT',
    body: JSON.stringify({ ...current.normalized_data, ...patch })
  });
}
