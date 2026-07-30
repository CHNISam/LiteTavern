import { createId } from './id';
import { t } from './i18n';
import {
  deleteLocalRecord,
  getAllByIndex,
  getAllLocalRecords,
  getLocalRecord,
  mutateLocalAssets,
  nowIso,
  putLocalRecord,
  type LocalBinding,
  type PersonaAsset,
  type PromptRole,
  type SelectiveLogic,
  type WorldbookAsset,
  type WorldbookEntryAsset,
  type WorldbookPosition,
  type WorldbookSource
} from './lore-store';

export type { SelectiveLogic, WorldbookPosition, WorldbookAsset, WorldbookEntryAsset };
export type Worldbook = WorldbookAsset & { entry_count: number };
export type WorldbookEntry = WorldbookEntryAsset;

export interface CharacterWorldbookLink {
  worldbook_id: string;
  name: string;
  enabled: boolean;
  link_enabled: boolean;
  entry_count: number;
  origin: WorldbookAsset['origin'];
}

export interface WorldbookEntryDraft {
  title: string;
  content: string;
  keys: string[];
  constant: boolean;
  enabled: boolean;
  position: WorldbookPosition;
  insertion_order: number;
}

export interface WorldbookDraft {
  name: string;
  description?: string;
  scan_depth?: number | null;
  token_budget?: number | null;
  recursive_scanning?: boolean;
  origin?: WorldbookAsset['origin'];
  source_character_id?: string | null;
  legacy_cloud_id?: string;
  entries?: Omit<WorldbookEntryAsset, 'worldbook_id'>[];
  source_fields?: Record<string, unknown>;
}

export interface SourcedWorldbookEntry extends WorldbookEntryAsset {
  source: WorldbookSource;
}

export interface SourcedWorldbookContext {
  entries: SourcedWorldbookEntry[];
  tokenBudget: number | null;
}

export const MAX_WORLDBOOK_NAME_LENGTH = 100;
export const MAX_ENTRY_TITLE_LENGTH = 200;
export const MAX_ENTRY_CONTENT_LENGTH = 20_000;
export const MAX_KEYS_PER_ENTRY = 64;
export const MAX_KEY_LENGTH = 200;
export const MAX_IMPORTED_ENTRIES = 512;
export const MAX_WORLDBOOK_TOKEN_BUDGET = 8_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textList(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, MAX_KEY_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_KEYS_PER_ENTRY);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampDepth(value: unknown, fallback = 4): number {
  return Math.min(20, Math.max(0, Math.trunc(finiteNumber(value, fallback))));
}

function promptRole(value: unknown): PromptRole {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return normalized === 'user' || normalized === 'assistant' ? normalized : 'system';
}

function positionFrom(source: Record<string, unknown>): WorldbookPosition {
  const extensions = record(source.extensions);
  const raw = extensions.position ?? source.position;
  if (
    raw === 4 ||
    raw === '4' ||
    (typeof raw === 'string' && raw.toLowerCase() === 'at_depth')
  ) {
    return 'AT_DEPTH';
  }
  if (
    raw === 0 ||
    (typeof raw === 'string' &&
      ['before_char', 'before character', 'before'].includes(raw.toLowerCase()))
  ) {
    return 'BEFORE_CHAR';
  }
  return 'AFTER_CHAR';
}

function selectiveLogic(value: unknown): SelectiveLogic {
  if (value === 'AND_ALL' || value === 3) return 'AND_ALL';
  if (value === 'NOT_ANY' || value === 2) return 'NOT_ANY';
  if (value === 'NOT_ALL' || value === 1) return 'NOT_ALL';
  return 'AND_ANY';
}

function unknownFields(
  source: Record<string, unknown>,
  known: readonly string[]
): Record<string, unknown> | undefined {
  const set = new Set(known);
  const result = Object.fromEntries(
    Object.entries(source).filter(([key]) => !set.has(key))
  );
  return Object.keys(result).length ? result : undefined;
}

export function normalizeKeys(keys: string[]): string[] {
  return textList(keys);
}

export function emptyEntryDraft(): WorldbookEntryDraft {
  return {
    title: '',
    content: '',
    keys: [],
    constant: false,
    enabled: true,
    position: 'AFTER_CHAR',
    insertion_order: 100
  };
}

export function entryFromDraft(
  draft: WorldbookEntryDraft
): Omit<WorldbookEntryAsset, 'worldbook_id'> {
  return {
    entry_id: createId(),
    title: draft.title.slice(0, MAX_ENTRY_TITLE_LENGTH),
    content: draft.content.slice(0, MAX_ENTRY_CONTENT_LENGTH),
    keys: normalizeKeys(draft.keys),
    secondary_keys: [],
    selective: false,
    selective_logic: 'AND_ANY',
    constant: draft.constant,
    enabled: draft.enabled,
    case_sensitive: false,
    match_whole_words: false,
    position: draft.position,
    insertion_order: draft.insertion_order,
    priority: null,
    probability: 100,
    use_probability: false,
    scan_depth: null,
    depth: 4,
    role: 'system',
    exclude_recursion: false,
    prevent_recursion: false,
    delay_until_recursion: false
  };
}

function entryAssetFromData(
  value: unknown
): Omit<WorldbookEntryAsset, 'worldbook_id'> | null {
  const source = record(value);
  const extensions = record(source.extensions);
  const runtime = { ...source, ...extensions };
  const content = typeof source.content === 'string' ? source.content : '';
  if (!content.trim()) return null;
  const sourceFields: Record<string, unknown> = {
    ...(unknownFields(source, [
      'key',
      'keys',
      'keysecondary',
      'secondary_keys',
      'comment',
      'name',
      'content',
      'order',
      'insertion_order',
      'disable',
      'enabled',
      'constant',
      'selective',
      'selectiveLogic',
      'caseSensitive',
      'case_sensitive',
      'matchWholeWords',
      'match_whole_words',
      'position',
      'depth',
      'role',
      'probability',
      'useProbability',
      'use_probability',
      'scanDepth',
      'scan_depth',
      'excludeRecursion',
      'exclude_recursion',
      'preventRecursion',
      'prevent_recursion',
      'delayUntilRecursion',
      'delay_until_recursion',
      'priority',
      'extensions'
    ]) ?? {})
  };
  // IDs and the extension object are passthrough data as well as useful compatibility
  // fields. Keeping them verbatim prevents a no-op round trip from renumbering entries.
  if ('id' in source) sourceFields.id = source.id;
  if ('uid' in source) sourceFields.uid = source.uid;
  if ('extensions' in source) sourceFields.extensions = source.extensions;

  return {
    entry_id: createId(),
    title:
      typeof source.name === 'string'
        ? source.name.slice(0, MAX_ENTRY_TITLE_LENGTH)
        : typeof source.comment === 'string'
          ? source.comment.slice(0, MAX_ENTRY_TITLE_LENGTH)
          : '',
    content: content.slice(0, MAX_ENTRY_CONTENT_LENGTH),
    keys: textList(source.keys ?? source.key),
    secondary_keys: textList(source.secondary_keys ?? source.keysecondary),
    selective:
      source.selective === true ||
      textList(source.secondary_keys ?? source.keysecondary).length > 0,
    selective_logic: selectiveLogic(source.selectiveLogic),
    constant: source.constant === true,
    enabled: source.disable === true ? false : source.enabled !== false,
    case_sensitive:
      runtime.case_sensitive === true || runtime.caseSensitive === true,
    match_whole_words:
      runtime.match_whole_words === true || runtime.matchWholeWords === true,
    position: positionFrom(source),
    insertion_order: finiteNumber(
      source.insertion_order,
      finiteNumber(source.order, 100)
    ),
    priority:
      typeof runtime.priority === 'number' && Number.isFinite(runtime.priority)
        ? runtime.priority
        : null,
    probability: Math.min(100, Math.max(0, finiteNumber(runtime.probability, 100))),
    use_probability:
      runtime.use_probability === true || runtime.useProbability === true,
    scan_depth:
      typeof runtime.scan_depth === 'number' || typeof runtime.scanDepth === 'number'
        ? clampDepth(runtime.scan_depth ?? runtime.scanDepth)
        : null,
    depth: clampDepth(runtime.depth, 4),
    role: promptRole(runtime.role),
    exclude_recursion:
      runtime.exclude_recursion === true || runtime.excludeRecursion === true,
    prevent_recursion:
      runtime.prevent_recursion === true || runtime.preventRecursion === true,
    delay_until_recursion:
      runtime.delay_until_recursion === true || runtime.delayUntilRecursion === true,
    ...(Object.keys(sourceFields).length ? { source_fields: sourceFields } : {})
  };
}

/** Synchronous parse helper used by preview and unit tests. */
export function entryFromCardData(value: unknown) {
  return entryAssetFromData(value);
}

export function worldbookDraftFromData(
  value: unknown,
  fallbackName: string
): WorldbookDraft | null {
  const source = record(value);
  const entryContainer = source.entries;
  const rawEntries = Array.isArray(entryContainer)
    ? entryContainer
    : Array.isArray(value)
      ? value
      : Object.values(record(entryContainer));
  const entries = rawEntries
    .slice(0, MAX_IMPORTED_ENTRIES)
    .flatMap((item) => {
      const entry = entryAssetFromData(item);
      return entry ? [entry] : [];
    });
  if (!entries.length) return null;
  const sourceFields = unknownFields(source, [
    'name',
    'description',
    'scan_depth',
    'token_budget',
    'recursive_scanning',
    'entries'
  ]);
  return {
    name:
      typeof source.name === 'string' && source.name.trim()
        ? source.name.trim()
        : fallbackName,
    description: typeof source.description === 'string' ? source.description : '',
    scan_depth:
      typeof source.scan_depth === 'number' ? clampDepth(source.scan_depth) : null,
    token_budget:
      typeof source.token_budget === 'number'
        ? Math.min(
            MAX_WORLDBOOK_TOKEN_BUDGET,
            Math.max(1, Math.trunc(source.token_budget))
          )
        : null,
    recursive_scanning: source.recursive_scanning !== false,
    entries,
    ...(sourceFields ? { source_fields: sourceFields } : {})
  };
}

export async function listWorldbooks(): Promise<Worldbook[]> {
  const [books, entries] = await Promise.all([
    getAllLocalRecords<WorldbookAsset>('worldbooks'),
    getAllLocalRecords<WorldbookEntryAsset>('worldbook_entries')
  ]);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.worldbook_id, (counts.get(entry.worldbook_id) ?? 0) + 1);
  }
  return books
    .map((book) => ({ ...book, entry_count: counts.get(book.worldbook_id) ?? 0 }))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export async function readWorldbook(
  worldbookId: string
): Promise<{ worldbook: Worldbook; entries: WorldbookEntry[] }> {
  const [book, entries] = await Promise.all([
    getLocalRecord<WorldbookAsset>('worldbooks', worldbookId),
    getAllByIndex<WorldbookEntryAsset>(
      'worldbook_entries',
      'worldbook_id',
      worldbookId
    )
  ]);
  if (!book) throw new Error(t().localAssets.worldbookNotFound);
  return {
    worldbook: { ...book, entry_count: entries.length },
    entries: entries.sort(
      (left, right) =>
        left.insertion_order - right.insertion_order ||
        left.entry_id.localeCompare(right.entry_id)
    )
  };
}

export async function createWorldbook(
  input: string | WorldbookDraft
): Promise<string> {
  const draft: WorldbookDraft = typeof input === 'string' ? { name: input } : input;
  const worldbookId = createId();
  const timestamp = nowIso();
  const book: WorldbookAsset = {
    worldbook_id: worldbookId,
    name:
      draft.name.trim().slice(0, MAX_WORLDBOOK_NAME_LENGTH) ||
      t().localAssets.unnamedWorldbook,
    description: draft.description ?? '',
    enabled: true,
    scan_depth:
      draft.scan_depth === null || draft.scan_depth === undefined
        ? null
        : clampDepth(draft.scan_depth),
    token_budget:
      draft.token_budget === null || draft.token_budget === undefined
        ? null
        : Math.min(
            MAX_WORLDBOOK_TOKEN_BUDGET,
            Math.max(1, Math.trunc(draft.token_budget))
          ),
    recursive_scanning: draft.recursive_scanning ?? true,
    origin: draft.origin ?? 'USER',
    source_character_id: draft.source_character_id ?? null,
    ...(draft.legacy_cloud_id ? { legacy_cloud_id: draft.legacy_cloud_id } : {}),
    ...(draft.source_fields ? { source_fields: draft.source_fields } : {}),
    created_at: timestamp,
    updated_at: timestamp
  };
  const entries = (draft.entries ?? []).map((entry) => ({
    ...entry,
    worldbook_id: worldbookId
  }));
  await mutateLocalAssets(['worldbooks', 'worldbook_entries'], (transaction) => {
    transaction.objectStore('worldbooks').put(book);
    for (const entry of entries) {
      transaction.objectStore('worldbook_entries').put(entry);
    }
  });
  return worldbookId;
}

export async function updateWorldbook(
  worldbookId: string,
  patch: Partial<Pick<WorldbookAsset, 'name' | 'description' | 'enabled'>>
): Promise<void> {
  const book = await getLocalRecord<WorldbookAsset>('worldbooks', worldbookId);
  if (!book) throw new Error(t().localAssets.worldbookNotFound);
  await putLocalRecord<WorldbookAsset>('worldbooks', {
    ...book,
    ...patch,
    ...(patch.name
      ? { name: patch.name.trim().slice(0, MAX_WORLDBOOK_NAME_LENGTH) }
      : {}),
    updated_at: nowIso()
  });
}

export async function deleteWorldbook(worldbookId: string): Promise<void> {
  const [entries, bindings] = await Promise.all([
    getAllByIndex<WorldbookEntryAsset>(
      'worldbook_entries',
      'worldbook_id',
      worldbookId
    ),
    getAllLocalRecords<LocalBinding>('bindings')
  ]);
  await mutateLocalAssets(
    ['worldbooks', 'worldbook_entries', 'bindings'],
    (transaction) => {
      transaction.objectStore('worldbooks').delete(worldbookId);
      for (const entry of entries) {
        transaction.objectStore('worldbook_entries').delete(entry.entry_id);
      }
      for (const binding of bindings) {
        if (binding.worldbook_ids?.includes(worldbookId)) {
          transaction.objectStore('bindings').put({
            ...binding,
            worldbook_ids: binding.worldbook_ids.filter((id) => id !== worldbookId)
          });
        }
      }
    }
  );
}

export async function createWorldbookEntry(
  worldbookId: string,
  draft: WorldbookEntryDraft
): Promise<void> {
  const book = await getLocalRecord<WorldbookAsset>('worldbooks', worldbookId);
  if (!book) throw new Error(t().localAssets.worldbookNotFound);
  const entry: WorldbookEntryAsset = {
    ...entryFromDraft(draft),
    worldbook_id: worldbookId
  };
  await mutateLocalAssets(['worldbooks', 'worldbook_entries'], (transaction) => {
    transaction.objectStore('worldbook_entries').put(entry);
    transaction.objectStore('worldbooks').put({ ...book, updated_at: nowIso() });
  });
}

export async function updateWorldbookEntry(
  first: string,
  second: string | Partial<WorldbookEntryDraft>,
  third?: Partial<WorldbookEntryDraft>
): Promise<void> {
  const entryId = third ? String(second) : first;
  const patch = (third ?? second) as Partial<WorldbookEntryDraft>;
  const entry = await getLocalRecord<WorldbookEntryAsset>(
    'worldbook_entries',
    entryId
  );
  if (!entry) throw new Error(t().localAssets.worldbookEntryNotFound);
  const next: WorldbookEntryAsset = {
    ...entry,
    ...(patch.title !== undefined
      ? { title: patch.title.slice(0, MAX_ENTRY_TITLE_LENGTH) }
      : {}),
    ...(patch.content !== undefined
      ? { content: patch.content.slice(0, MAX_ENTRY_CONTENT_LENGTH) }
      : {}),
    ...(patch.keys !== undefined ? { keys: normalizeKeys(patch.keys) } : {}),
    ...(patch.constant !== undefined ? { constant: patch.constant } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.insertion_order !== undefined
      ? { insertion_order: patch.insertion_order }
      : {})
  };
  await putLocalRecord('worldbook_entries', next);
}

export async function deleteWorldbookEntry(
  first: string,
  second?: string
): Promise<void> {
  await deleteLocalRecord('worldbook_entries', second ?? first);
}

function bindingKey(kind: 'global' | 'character' | 'conversation', id = '') {
  return kind === 'global' ? 'global' : `${kind}:${id}`;
}

async function worldbookIdsForBinding(key: string): Promise<string[]> {
  return (
    (await getLocalRecord<LocalBinding>('bindings', key))?.worldbook_ids ?? []
  );
}

export async function characterWorldbookIds(characterId: string): Promise<string[]> {
  return worldbookIdsForBinding(bindingKey('character', characterId));
}

export async function setCharacterWorldbooks(
  characterId: string,
  values: Array<string | { worldbook_id: string }>
): Promise<CharacterWorldbookLink[]> {
  const ids = [
    ...new Set(
      values.map((value) =>
        typeof value === 'string' ? value : value.worldbook_id
      )
    )
  ];
  const known = new Set((await listWorldbooks()).map((book) => book.worldbook_id));
  const key = bindingKey('character', characterId);
  const current = (await getLocalRecord<LocalBinding>('bindings', key)) ?? {
    binding_id: key
  };
  await putLocalRecord<LocalBinding>('bindings', {
    ...current,
    worldbook_ids: ids.filter((id) => known.has(id))
  });
  return listCharacterWorldbooks(characterId);
}

export async function listCharacterWorldbooks(
  characterId: string
): Promise<CharacterWorldbookLink[]> {
  const [books, ids] = await Promise.all([
    listWorldbooks(),
    characterWorldbookIds(characterId)
  ]);
  const linked = new Set(ids);
  return books
    .filter((book) => linked.has(book.worldbook_id))
    .map((book) => ({
      worldbook_id: book.worldbook_id,
      name: book.name,
      enabled: book.enabled,
      link_enabled: true,
      entry_count: book.entry_count,
      origin: book.origin
    }));
}

export async function characterCardWorldbook(
  characterId: string
): Promise<Worldbook | null> {
  const books = await listWorldbooks();
  return (
    books.find(
      (book) =>
        book.origin === 'CHARACTER_BOOK' &&
        book.source_character_id === characterId
    ) ?? null
  );
}

export async function replaceCharacterCardWorldbook(
  characterId: string,
  value: unknown,
  fallbackName: string
): Promise<Worldbook | null> {
  const previous = (await listWorldbooks()).filter(
    (book) =>
      book.origin === 'CHARACTER_BOOK' &&
      book.source_character_id === characterId
  );
  if (value === null || value === undefined) {
    for (const book of previous) await deleteWorldbook(book.worldbook_id);
    return null;
  }
  const imported = await importWorldbook(value, fallbackName, {
    origin: 'CHARACTER_BOOK',
    source_character_id: characterId
  });
  for (const book of previous) {
    if (book.worldbook_id !== imported.worldbook_id) {
      await deleteWorldbook(book.worldbook_id);
    }
  }
  return imported;
}

export async function setGlobalWorldbooks(ids: string[]): Promise<void> {
  await putLocalRecord<LocalBinding>('bindings', {
    binding_id: 'global',
    worldbook_ids: [...new Set(ids)]
  });
}

export async function setConversationWorldbooks(
  conversationId: string,
  ids: string[]
): Promise<void> {
  const key = bindingKey('conversation', conversationId);
  const current = (await getLocalRecord<LocalBinding>('bindings', key)) ?? {
    binding_id: key
  };
  await putLocalRecord('bindings', {
    ...current,
    worldbook_ids: [...new Set(ids)]
  });
}

function personaBookNames(persona: PersonaAsset | null): string[] {
  if (!persona?.lorebook) return [];
  return Array.isArray(persona.lorebook) ? persona.lorebook : [persona.lorebook];
}

/**
 * Resolve all four local sources and de-duplicate by worldbook id. Entry-level
 * scan depth wins; otherwise the containing book supplies the runtime default.
 * When several books are active, the most generous configured token budget wins
 * so linking another book cannot silently shrink the existing context.
 */
export async function sourcedWorldbookContextForTurn(
  characterId: string,
  conversationId: string,
  persona: PersonaAsset | null
): Promise<SourcedWorldbookContext> {
  const [books, entries, globalIds, characterIds, conversationIds] =
    await Promise.all([
      getAllLocalRecords<WorldbookAsset>('worldbooks'),
      getAllLocalRecords<WorldbookEntryAsset>('worldbook_entries'),
      worldbookIdsForBinding('global'),
      worldbookIdsForBinding(bindingKey('character', characterId)),
      worldbookIdsForBinding(bindingKey('conversation', conversationId))
    ]);
  const names = new Set(personaBookNames(persona));
  const personaIds = books
    .filter(
      (book) => names.has(book.worldbook_id) || names.has(book.name)
    )
    .map((book) => book.worldbook_id);
  const sources: Array<[WorldbookSource, string[]]> = [
    ['GLOBAL', globalIds],
    ['CHARACTER', characterIds],
    ['CONVERSATION', conversationIds],
    ['PERSONA', personaIds]
  ];
  const sourceByBook = new Map<string, WorldbookSource>();
  for (const [source, ids] of sources) {
    for (const id of ids) {
      if (!sourceByBook.has(id)) sourceByBook.set(id, source);
    }
  }
  const enabled = new Set(
    books
      .filter((book) => book.enabled && sourceByBook.has(book.worldbook_id))
      .map((book) => book.worldbook_id)
  );
  const bookById = new Map(books.map((book) => [book.worldbook_id, book]));
  const activeBooks = books.filter((book) => enabled.has(book.worldbook_id));
  const configuredBudgets = activeBooks.flatMap((book) =>
    book.token_budget === null ? [] : [book.token_budget]
  );
  const sourcedEntries = entries.flatMap((entry) => {
    const source = sourceByBook.get(entry.worldbook_id);
    const book = bookById.get(entry.worldbook_id);
    return source && enabled.has(entry.worldbook_id)
      ? [
          {
            ...entry,
            scan_depth: entry.scan_depth ?? book?.scan_depth ?? null,
            source
          }
        ]
      : [];
  });
  return {
    entries: sourcedEntries,
    tokenBudget: configuredBudgets.length
      ? Math.min(MAX_WORLDBOOK_TOKEN_BUDGET, Math.max(...configuredBudgets))
      : null
  };
}

/** Compatibility helper for callers that only need the entries. */
export async function sourcedEntriesForTurn(
  characterId: string,
  conversationId: string,
  persona: PersonaAsset | null
): Promise<SourcedWorldbookEntry[]> {
  return (
    await sourcedWorldbookContextForTurn(
      characterId,
      conversationId,
      persona
    )
  ).entries;
}

export async function importWorldbook(
  value: unknown,
  fallbackName = t().localAssets.importedWorldbookName,
  options: Pick<
    WorldbookDraft,
    'origin' | 'source_character_id' | 'legacy_cloud_id'
  > = {}
): Promise<Worldbook> {
  const draft = worldbookDraftFromData(value, fallbackName);
  if (!draft) throw new Error(t().localAssets.worldbookImportEmpty);
  const worldbookId = await createWorldbook({ ...draft, ...options });
  const detail = await readWorldbook(worldbookId);
  if (options.source_character_id) {
    const current = await characterWorldbookIds(options.source_character_id);
    await setCharacterWorldbooks(options.source_character_id, [
      ...current,
      worldbookId
    ]);
  }
  return detail.worldbook;
}

export async function exportWorldbook(
  worldbookId: string
): Promise<Record<string, unknown> | null> {
  let detail;
  try {
    detail = await readWorldbook(worldbookId);
  } catch {
    return null;
  }
  const { worldbook: book, entries } = detail;
  return {
    ...(book.source_fields ?? {}),
    name: book.name,
    description: book.description,
    ...(book.scan_depth === null ? {} : { scan_depth: book.scan_depth }),
    ...(book.token_budget === null ? {} : { token_budget: book.token_budget }),
    recursive_scanning: book.recursive_scanning,
    entries: entries.map((entry, index) => {
      const preserved = entry.source_fields ?? {};
      const preservedExtensions = record(preserved.extensions);
      const extensions = {
        ...preservedExtensions,
        position:
          entry.position === 'AT_DEPTH'
            ? 4
            : preservedExtensions.position ?? undefined,
        ...(entry.position === 'AT_DEPTH' ? { depth: entry.depth } : {}),
        role: entry.role,
        probability: entry.probability,
        useProbability: entry.use_probability,
        ...(entry.scan_depth === null ? {} : { scanDepth: entry.scan_depth }),
        excludeRecursion: entry.exclude_recursion,
        preventRecursion: entry.prevent_recursion,
        delayUntilRecursion: entry.delay_until_recursion
      };
      return {
        ...preserved,
        keys: entry.keys,
        secondary_keys: entry.secondary_keys,
        content: entry.content,
        enabled: entry.enabled,
        insertion_order: entry.insertion_order,
        case_sensitive: entry.case_sensitive,
        name: entry.title,
        constant: entry.constant,
        position:
          entry.position === 'BEFORE_CHAR' ? 'before_char' : 'after_char',
        selective: entry.selective,
        selectiveLogic: {
          AND_ANY: 0,
          NOT_ALL: 1,
          NOT_ANY: 2,
          AND_ALL: 3
        }[entry.selective_logic],
        ...(entry.priority === null ? {} : { priority: entry.priority }),
        id:
          typeof preserved.id === 'number'
            ? preserved.id
            : typeof preserved.uid === 'number'
              ? preserved.uid
              : index,
        extensions
      };
    })
  };
}
