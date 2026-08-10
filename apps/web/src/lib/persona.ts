import { createId } from './id';
import { t } from './i18n';
import {
  deleteLocalRecord,
  getAllLocalRecords,
  getLocalRecord,
  getMeta,
  mutateLocalAssets,
  nowIso,
  putLocalRecord,
  setMeta,
  type LocalBinding,
  type PersonaAsset,
  type PersonaPosition,
  type PromptRole
} from './lore-store';

export type Persona = PersonaAsset & { is_default: boolean };

export interface PersonaDraft {
  name: string;
  description: string;
  title?: string;
  position?: PersonaPosition;
  depth?: number | null;
  role?: PromptRole;
  lorebook?: string | string[] | null;
  connections?: unknown[];
  avatar_name?: string | null;
  avatar_blob?: Blob | null;
  avatar_missing?: boolean;
  legacy_cloud_id?: string;
  source_fields?: Record<string, unknown>;
}

export const MAX_PERSONA_NAME_LENGTH = 100;
export const MAX_PERSONA_DESCRIPTION_LENGTH = 4_000;
export function defaultUserLabel(): string {
  return t().localAssets.defaultUserLabel;
}
const DEFAULT_PERSONA_META = 'default_persona_id';

function clampDepth(value: unknown, fallback = 2): number {
  return Math.min(20, Math.max(0, Math.trunc(Number(value) || fallback)));
}

function normalizePosition(value: unknown): PersonaPosition {
  if (typeof value === 'number') {
    if (value === 0) return 'NONE';
    if (value === 4) return 'AT_DEPTH';
    return 'IN_PROMPT'; // 1, 2, 3 fallback to IN_PROMPT internally
  }
  const normalized = typeof value === 'string' ? value.toUpperCase() : '';
  if (normalized === 'AT_DEPTH') return 'AT_DEPTH';
  if (normalized === 'NONE') return 'NONE';
  // AFTER_CHAR is a deprecated Persona position. It behaves as in-prompt here but
  // remains present in source_fields for a lossless export.
  return 'IN_PROMPT';
}

function normalizeRole(value: unknown): PromptRole {
  if (typeof value === 'number') {
    if (value === 1) return 'user';
    if (value === 2) return 'assistant';
    return 'system';
  }
  return value === 'user' || value === 'assistant' ? value : 'system';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unknownFields(
  source: Record<string, unknown>,
  known: readonly string[]
): Record<string, unknown> | undefined {
  const knownSet = new Set(known);
  const result = Object.fromEntries(
    Object.entries(source).filter(([key]) => !knownSet.has(key))
  );
  return Object.keys(result).length ? result : undefined;
}

function assetFromDraft(draft: PersonaDraft): PersonaAsset {
  const timestamp = nowIso();
  return {
    persona_id: createId(),
    name: draft.name.trim().slice(0, MAX_PERSONA_NAME_LENGTH),
    description: draft.description.slice(0, MAX_PERSONA_DESCRIPTION_LENGTH),
    title: draft.title?.slice(0, 200) ?? '',
    position: normalizePosition(draft.position),
    depth: draft.position === 'AT_DEPTH' ? clampDepth(draft.depth) : null,
    role: normalizeRole(draft.role),
    lorebook: draft.lorebook ?? null,
    connections: draft.connections ?? [],
    avatar_name: draft.avatar_name ?? null,
    ...(draft.avatar_blob !== undefined ? { avatar_blob: draft.avatar_blob } : {}),
    avatar_missing: draft.avatar_missing ?? !draft.avatar_blob,
    ...(draft.legacy_cloud_id ? { legacy_cloud_id: draft.legacy_cloud_id } : {}),
    ...(draft.source_fields ? { source_fields: draft.source_fields } : {}),
    created_at: timestamp,
    updated_at: timestamp
  };
}

export async function listPersonas(): Promise<Persona[]> {
  const [assets, defaultId] = await Promise.all([
    getAllLocalRecords<PersonaAsset>('personas'),
    getMeta<string>(DEFAULT_PERSONA_META)
  ]);
  return assets
    .map((persona) => ({ ...persona, is_default: persona.persona_id === defaultId }))
    .sort((left, right) => {
      if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
      return right.updated_at.localeCompare(left.updated_at);
    });
}

export async function readPersona(personaId: string | null): Promise<Persona | null> {
  if (!personaId) return null;
  const [persona, defaultId] = await Promise.all([
    getLocalRecord<PersonaAsset>('personas', personaId),
    getMeta<string>(DEFAULT_PERSONA_META)
  ]);
  return persona ? { ...persona, is_default: persona.persona_id === defaultId } : null;
}

export async function defaultPersonaId(): Promise<string | null> {
  return getMeta<string>(DEFAULT_PERSONA_META);
}

export async function createPersona(draft: PersonaDraft): Promise<Persona> {
  const persona = assetFromDraft(draft);
  if (!persona.name) throw new Error(t().localAssets.personaNameRequired);
  const currentDefault = await defaultPersonaId();
  await mutateLocalAssets(
    currentDefault ? ['personas'] : ['personas', 'meta'],
    (transaction) => {
      transaction.objectStore('personas').put(persona);
      if (!currentDefault) {
        transaction.objectStore('meta').put({
          key: DEFAULT_PERSONA_META,
          value: persona.persona_id
        });
      }
    }
  );
  return { ...persona, is_default: currentDefault === null };
}

export async function updatePersona(
  personaId: string,
  patch: Partial<PersonaDraft> & { is_default?: true }
): Promise<Persona> {
  const current = await getLocalRecord<PersonaAsset>('personas', personaId);
  if (!current) throw new Error(t().localAssets.personaNotFound);
  const next: PersonaAsset = {
    ...current,
    ...(patch.name !== undefined
      ? { name: patch.name.trim().slice(0, MAX_PERSONA_NAME_LENGTH) }
      : {}),
    ...(patch.description !== undefined
      ? { description: patch.description.slice(0, MAX_PERSONA_DESCRIPTION_LENGTH) }
      : {}),
    ...(patch.title !== undefined ? { title: patch.title.slice(0, 200) } : {}),
    ...(patch.position !== undefined
      ? { position: normalizePosition(patch.position) }
      : {}),
    ...(patch.depth !== undefined ? { depth: clampDepth(patch.depth) } : {}),
    ...(patch.role !== undefined ? { role: normalizeRole(patch.role) } : {}),
    ...(patch.lorebook !== undefined ? { lorebook: patch.lorebook } : {}),
    ...(patch.connections !== undefined ? { connections: patch.connections } : {}),
    ...(patch.avatar_blob !== undefined
      ? { avatar_blob: patch.avatar_blob, avatar_missing: !patch.avatar_blob }
      : {}),
    updated_at: nowIso()
  };
  if (!next.name) throw new Error(t().localAssets.personaNameRequired);
  await mutateLocalAssets(
    patch.is_default ? ['personas', 'meta'] : ['personas'],
    (transaction) => {
      transaction.objectStore('personas').put(next);
      if (patch.is_default) {
        transaction.objectStore('meta').put({
          key: DEFAULT_PERSONA_META,
          value: personaId
        });
      }
    }
  );
  return { ...next, is_default: patch.is_default === true };
}

export async function setDefaultPersona(personaId: string | null): Promise<void> {
  if (personaId && !(await getLocalRecord('personas', personaId))) {
    throw new Error(t().localAssets.personaNotFound);
  }
  await setMeta(DEFAULT_PERSONA_META, personaId);
}

export async function deletePersona(personaId: string): Promise<void> {
  const [bindings, defaultId] = await Promise.all([
    getAllLocalRecords<LocalBinding>('bindings'),
    defaultPersonaId()
  ]);
  await mutateLocalAssets(['personas', 'bindings', 'meta'], (transaction) => {
    transaction.objectStore('personas').delete(personaId);
    for (const binding of bindings) {
      if (binding.persona_id === personaId) {
        transaction.objectStore('bindings').put({ ...binding, persona_id: null });
      }
    }
    if (defaultId === personaId) {
      transaction.objectStore('meta').put({ key: DEFAULT_PERSONA_META, value: null });
    }
  });
}

function bindingId(kind: 'conversation' | 'character', id: string): string {
  return `${kind}:${id}`;
}

export async function bindConversationPersona(
  conversationId: string,
  personaId: string | null
): Promise<void> {
  const key = bindingId('conversation', conversationId);
  const current = (await getLocalRecord<LocalBinding>('bindings', key)) ?? {
    binding_id: key
  };
  await putLocalRecord<LocalBinding>('bindings', {
    ...current,
    persona_id: personaId,
    persona_resolved: true
  });
}

export async function readConversationPersona(
  conversationId: string
): Promise<string | null | undefined> {
  const binding = await getLocalRecord<LocalBinding>(
    'bindings',
    bindingId('conversation', conversationId)
  );
  return binding?.persona_resolved ? binding.persona_id ?? null : undefined;
}

export async function bindCharacterPersona(
  characterId: string,
  personaId: string | null
): Promise<void> {
  const key = bindingId('character', characterId);
  const current = (await getLocalRecord<LocalBinding>('bindings', key)) ?? {
    binding_id: key
  };
  await putLocalRecord<LocalBinding>('bindings', { ...current, persona_id: personaId });
}

function connectionMatches(connection: unknown, characterId: string): boolean {
  if (connection === characterId) return true;
  const value = record(connection);
  return (
    value.character_id === characterId ||
    value.characterId === characterId ||
    value.id === characterId
  );
}

/**
 * Resolve once per conversation: explicit conversation choice → character connection
 * → default Persona → none. The result is persisted so later default changes do not
 * silently re-cast an established conversation.
 */
export async function resolveConversationPersona(
  conversationId: string,
  characterId: string
): Promise<Persona | null> {
  const existing = await readConversationPersona(conversationId);
  if (existing !== undefined) return readPersona(existing);

  const [characterBinding, personas, defaultId] = await Promise.all([
    getLocalRecord<LocalBinding>('bindings', bindingId('character', characterId)),
    getAllLocalRecords<PersonaAsset>('personas'),
    defaultPersonaId()
  ]);
  const connected =
    characterBinding && 'persona_id' in characterBinding
      ? characterBinding.persona_id ?? null
      : personas.find((persona) =>
          persona.connections.some((connection) =>
            connectionMatches(connection, characterId)
          )
        )?.persona_id ?? defaultId;
  await bindConversationPersona(conversationId, connected ?? null);
  return readPersona(connected ?? null);
}

export interface PersonaImportResult {
  added: number;
  missing_avatars: number;
  persona_ids: string[];
}

function draftsFromImport(value: unknown): {
  drafts: PersonaDraft[];
  defaultAvatarName: string | null;
} {
  const source = record(value);
  const names = record(source.personas);
  const descriptions = record(source.persona_descriptions);
  if (Object.keys(names).length > 0) {
    const drafts = Object.entries(names).flatMap(([avatarName, rawName]) => {
      if (typeof rawName !== 'string' || !rawName.trim()) return [];
      const details = record(descriptions[avatarName]);
      const rawPosition = details.position;
      const known = [
        'description',
        'title',
        'position',
        'depth',
        'role',
        'lorebook',
        'connections'
      ];
      const sourceFields = {
        ...(unknownFields(details, known) ?? {}),
        ...(rawPosition === 'AFTER_CHAR' ||
        rawPosition === 'TOP_AN' ||
        rawPosition === 'BOTTOM_AN'
          ? { position: rawPosition }
          : {})
      };
      return [
        {
          name: rawName,
          description:
            typeof details.description === 'string' ? details.description : '',
          title: typeof details.title === 'string' ? details.title : '',
          position: normalizePosition(rawPosition),
          depth: typeof details.depth === 'number' ? clampDepth(details.depth) : null,
          role: normalizeRole(details.role),
          lorebook:
            typeof details.lorebook === 'string' || Array.isArray(details.lorebook)
              ? (details.lorebook as string | string[])
              : null,
          connections: Array.isArray(details.connections) ? details.connections : [],
          avatar_name: avatarName,
          avatar_missing: true,
          ...(Object.keys(sourceFields).length ? { source_fields: sourceFields } : {})
        }
      ];
    });
    return {
      drafts,
      defaultAvatarName:
        typeof source.default_persona === 'string' ? source.default_persona : null
    };
  }

  const items = Array.isArray(source.personas)
    ? source.personas
    : Array.isArray(value)
      ? value
      : [];
  return {
    drafts: items.flatMap((item) => {
      const raw = record(item);
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) return [];
      const sourceFields = unknownFields(raw, [
        'name',
        'description',
        'title',
        'position',
        'depth',
        'role',
        'lorebook',
        'connections',
        'avatar_name'
      ]);
      return [
        {
          name,
          description: typeof raw.description === 'string' ? raw.description : '',
          title: typeof raw.title === 'string' ? raw.title : '',
          position: normalizePosition(raw.position),
          depth: typeof raw.depth === 'number' ? raw.depth : null,
          role: normalizeRole(raw.role),
          lorebook:
            typeof raw.lorebook === 'string' || Array.isArray(raw.lorebook)
              ? (raw.lorebook as string | string[])
              : null,
          connections: Array.isArray(raw.connections) ? raw.connections : [],
          avatar_name: typeof raw.avatar_name === 'string' ? raw.avatar_name : null,
          avatar_missing: true,
          ...(sourceFields ? { source_fields: sourceFields } : {})
        }
      ];
    }),
    defaultAvatarName:
      typeof source.default_persona === 'string' ? source.default_persona : null
  };
}

function ensureUniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }

  let baseName = name;
  let counter = 2;
  const match = name.match(/^(.*?) \((\d+)\)$/);
  if (match) {
    baseName = match[1];
    counter = parseInt(match[2], 10) + 1;
  }

  let unique = `${baseName} (${counter})`;
  while (taken.has(unique)) {
    counter += 1;
    unique = `${baseName} (${counter})`;
  }
  
  taken.add(unique);
  return unique;
}

export async function importPersonas(value: unknown): Promise<PersonaImportResult> {
  const { drafts, defaultAvatarName } = draftsFromImport(value);
  if (!drafts.length) throw new Error(t().localAssets.personaImportEmpty);
  
  const existingPersonas = await getAllLocalRecords<PersonaAsset>('personas');
  const takenNames = new Set(existingPersonas.map((p) => p.name));
  
  const assets = drafts.map((draft) => {
    draft.name = ensureUniqueName(draft.name, takenNames);
    return assetFromDraft(draft);
  });
  const defaultAsset = assets.find(
    (persona) => persona.avatar_name === defaultAvatarName
  );
  const previousDefault = await defaultPersonaId();
  await mutateLocalAssets(['personas', 'meta'], (transaction) => {
    for (const persona of assets) transaction.objectStore('personas').put(persona);
    if (defaultAsset || !previousDefault) {
      transaction.objectStore('meta').put({
        key: DEFAULT_PERSONA_META,
        value: defaultAsset?.persona_id ?? assets[0]?.persona_id ?? null
      });
    }
  });
  return {
    added: assets.length,
    missing_avatars: assets.filter((persona) => persona.avatar_missing).length,
    persona_ids: assets.map((persona) => persona.persona_id)
  };
}

export async function exportPersonas(): Promise<Record<string, unknown>> {
  const [personas, defaultId] = await Promise.all([
    getAllLocalRecords<PersonaAsset>('personas'),
    defaultPersonaId()
  ]);
  const avatarName = (persona: PersonaAsset, index: number) =>
    persona.avatar_name || `persona-${index + 1}.png`;
  const names: Record<string, string> = {};
  const descriptions: Record<string, unknown> = {};
  let defaultPersona: string | null = null;
  personas.forEach((persona, index) => {
    const avatar = avatarName(persona, index);
    names[avatar] = persona.name;
    descriptions[avatar] = {
      ...(persona.source_fields ?? {}),
      description: persona.description,
      title: persona.title,
      position: persona.position,
      ...(persona.position === 'AT_DEPTH' ? { depth: persona.depth ?? 2 } : {}),
      role: persona.role,
      ...(persona.lorebook ? { lorebook: persona.lorebook } : {}),
      ...(persona.connections.length ? { connections: persona.connections } : {})
    };
    if (persona.persona_id === defaultId) defaultPersona = avatar;
  });
  return {
    personas: names,
    persona_descriptions: descriptions,
    default_persona: defaultPersona
  };
}

/** Used only by migration cleanup/tests. */
export async function clearConversationPersona(conversationId: string): Promise<void> {
  await deleteLocalRecord('bindings', bindingId('conversation', conversationId));
}

export function draftFromCharacterCard(
  cardData: Record<string, unknown>,
  avatarName: string | null = null,
  avatarBlob: Blob | null = null
): PersonaDraft {
  const data = cardData.data && typeof cardData.data === 'object'
    ? (cardData.data as Record<string, unknown>)
    : cardData;

  const text = (keys: string[]) => {
    for (const key of keys) {
      if (typeof data[key] === 'string') return data[key] as string;
    }
    return '';
  };

  const rawName = text(['name', 'char_name']).trim();
  const rawDescription = text(['description', 'char_persona']);
  const rawPersonality = text(['personality']);

  const swapSemantics = (content: string) => {
    return content
      .replace(/\{\{user\}\}/gi, '__TEMP_USER_MACRO__')
      .replace(/\{\{char\}\}/gi, '{{user}}')
      .replace(/__TEMP_USER_MACRO__/g, '{{char}}');
  };

  const combinedDesc = [
    swapSemantics(rawDescription),
    swapSemantics(rawPersonality)
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: rawName || t().localAssets.defaultUserLabel,
    description: combinedDesc,
    title: '',
    position: 'IN_PROMPT',
    role: 'system',
    avatar_name: avatarName,
    avatar_blob: avatarBlob,
    avatar_missing: !avatarBlob
  };
}
