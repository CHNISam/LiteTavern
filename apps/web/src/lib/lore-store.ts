import { t } from './i18n';

/**
 * Versioned browser-local asset database.
 *
 * Persona, worldbook and Regex source text is intentionally absent from LiteTavern
 * Cloud. IndexedDB is the source of truth; Cloud only receives the bounded snippets
 * selected for one generation turn.
 */

export const LORE_DB_NAME = 'litetavern-local-assets';
export const LORE_DB_VERSION = 1;

export const LORE_STORES = [
  'personas',
  'worldbooks',
  'worldbook_entries',
  'regex_scripts',
  'bindings',
  'permissions',
  'meta'
] as const;

export type LoreStoreName = (typeof LORE_STORES)[number];
export type PersonaPosition = 'IN_PROMPT' | 'AT_DEPTH' | 'NONE';
export type PromptRole = 'system' | 'user' | 'assistant';
export type WorldbookPosition = 'BEFORE_CHAR' | 'AFTER_CHAR' | 'AT_DEPTH';
export type SelectiveLogic = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL';
export type WorldbookSource = 'GLOBAL' | 'CHARACTER' | 'CONVERSATION' | 'PERSONA';

export interface PersonaAsset {
  persona_id: string;
  name: string;
  description: string;
  title: string;
  position: PersonaPosition;
  depth: number | null;
  role: PromptRole;
  lorebook: string | string[] | null;
  connections: unknown[];
  avatar_name: string | null;
  avatar_blob?: Blob | null;
  avatar_missing: boolean;
  legacy_cloud_id?: string;
  source_fields?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorldbookAsset {
  worldbook_id: string;
  name: string;
  description: string;
  enabled: boolean;
  scan_depth: number | null;
  token_budget: number | null;
  recursive_scanning: boolean;
  origin: 'USER' | 'CHARACTER_BOOK' | 'LEGACY_CLOUD';
  source_character_id: string | null;
  legacy_cloud_id?: string;
  source_fields?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorldbookEntryAsset {
  entry_id: string;
  worldbook_id: string;
  title: string;
  content: string;
  keys: string[];
  secondary_keys: string[];
  selective: boolean;
  selective_logic: SelectiveLogic;
  constant: boolean;
  enabled: boolean;
  case_sensitive: boolean;
  match_whole_words: boolean;
  position: WorldbookPosition;
  insertion_order: number;
  priority: number | null;
  probability: number;
  use_probability: boolean;
  scan_depth: number | null;
  depth: number;
  role: PromptRole;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
  delay_until_recursion: boolean;
  source_fields?: Record<string, unknown>;
}

export interface LocalBinding {
  binding_id: string;
  persona_id?: string | null;
  persona_resolved?: boolean;
  worldbook_ids?: string[];
}

export interface RegexScriptRecord {
  script_id: string;
  scope: 'GLOBAL' | 'CHARACTER';
  character_id: string | null;
  bundle_hash: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RegexPermissionRecord {
  permission_id: string;
  character_id: string;
  regex_bundle_hash: string;
  granted_at: string;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

let databasePromise: Promise<IDBDatabase> | null = null;
const listeners = new Set<() => void>();

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_REQUEST_FAILED'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('INDEXED_DB_TRANSACTION_FAILED'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('INDEXED_DB_TRANSACTION_ABORTED'));
  });
}

function localStoreError(reason: unknown): Error {
  if (
    reason instanceof DOMException &&
    (reason.name === 'QuotaExceededError' || reason.name === 'UnknownError')
  ) {
    return new Error(t().localAssets.storageQuotaExceeded);
  }
  return reason instanceof Error
    ? reason
    : new Error(t().localAssets.storageSaveFailed);
}

function createSchema(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains('personas')) {
    const store = database.createObjectStore('personas', { keyPath: 'persona_id' });
    store.createIndex('legacy_cloud_id', 'legacy_cloud_id', { unique: false });
  }
  if (!database.objectStoreNames.contains('worldbooks')) {
    const store = database.createObjectStore('worldbooks', { keyPath: 'worldbook_id' });
    store.createIndex('legacy_cloud_id', 'legacy_cloud_id', { unique: false });
  }
  if (!database.objectStoreNames.contains('worldbook_entries')) {
    const store = database.createObjectStore('worldbook_entries', { keyPath: 'entry_id' });
    store.createIndex('worldbook_id', 'worldbook_id', { unique: false });
  }
  if (!database.objectStoreNames.contains('regex_scripts')) {
    const store = database.createObjectStore('regex_scripts', { keyPath: 'script_id' });
    store.createIndex('scope', 'scope', { unique: false });
    store.createIndex('character_id', 'character_id', { unique: false });
  }
  if (!database.objectStoreNames.contains('bindings')) {
    database.createObjectStore('bindings', { keyPath: 'binding_id' });
  }
  if (!database.objectStoreNames.contains('permissions')) {
    database.createObjectStore('permissions', { keyPath: 'permission_id' });
  }
  if (!database.objectStoreNames.contains('meta')) {
    database.createObjectStore('meta', { keyPath: 'key' });
  }
}

export function openLoreDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(t().localAssets.indexedDbUnsupported));
      return;
    }
    const request = indexedDB.open(LORE_DB_NAME, LORE_DB_VERSION);
    request.onupgradeneeded = () => createSchema(request.result);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('INDEXED_DB_OPEN_FAILED'));
    request.onblocked = () => reject(new Error('INDEXED_DB_UPGRADE_BLOCKED'));
  });
  return databasePromise;
}

export async function getLocalRecord<T>(
  storeName: LoreStoreName,
  key: IDBValidKey
): Promise<T | null> {
  const database = await openLoreDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const value = await requestResult(transaction.objectStore(storeName).get(key));
  await transactionDone(transaction);
  return (value as T | undefined) ?? null;
}

export async function getAllLocalRecords<T>(
  storeName: LoreStoreName
): Promise<T[]> {
  const database = await openLoreDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const values = await requestResult(transaction.objectStore(storeName).getAll());
  await transactionDone(transaction);
  return values as T[];
}

export async function getAllByIndex<T>(
  storeName: LoreStoreName,
  indexName: string,
  key: IDBValidKey
): Promise<T[]> {
  const database = await openLoreDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const values = await requestResult(
    transaction.objectStore(storeName).index(indexName).getAll(key)
  );
  await transactionDone(transaction);
  return values as T[];
}

export async function putLocalRecord<T>(
  storeName: LoreStoreName,
  value: T
): Promise<void> {
  try {
    const database = await openLoreDatabase();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
    notifyLoreChanged();
  } catch (reason) {
    throw localStoreError(reason);
  }
}

export async function deleteLocalRecord(
  storeName: LoreStoreName,
  key: IDBValidKey
): Promise<void> {
  try {
    const database = await openLoreDatabase();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
    notifyLoreChanged();
  } catch (reason) {
    throw localStoreError(reason);
  }
}

/**
 * Atomic multi-store mutation. The callback queues requests synchronously; completion
 * is reported only after every store has committed.
 */
export async function mutateLocalAssets(
  stores: LoreStoreName[],
  mutate: (transaction: IDBTransaction) => void
): Promise<void> {
  try {
    const database = await openLoreDatabase();
    const transaction = database.transaction(stores, 'readwrite');
    try {
      mutate(transaction);
    } catch (reason) {
      transaction.abort();
      await transactionDone(transaction).catch(() => undefined);
      throw reason;
    }
    await transactionDone(transaction);
    notifyLoreChanged();
  } catch (reason) {
    throw localStoreError(reason);
  }
}

export async function getMeta<T>(key: string): Promise<T | null> {
  const record = await getLocalRecord<MetaRecord>('meta', key);
  return (record?.value as T | undefined) ?? null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await putLocalRecord<MetaRecord>('meta', { key, value });
}

export function subscribeLore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyLoreChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Test seam. It deletes only this app's dedicated local-asset database. */
export async function resetLoreDatabaseForTests(): Promise<void> {
  const database = databasePromise ? await databasePromise.catch(() => null) : null;
  database?.close();
  databasePromise = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LORE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/** Backward-compatible test name retained while old WIP tests are migrated. */
export function resetLoreCache(): void {
  databasePromise = null;
}
