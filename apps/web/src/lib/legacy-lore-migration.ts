import { createId } from './id';
import { t } from './i18n';
import {
  getAllLocalRecords,
  getMeta,
  mutateLocalAssets,
  nowIso,
  type PersonaAsset,
  type WorldbookAsset,
  type WorldbookEntryAsset
} from './lore-store';
import { worldbookDraftFromData } from './worldbook';

export const LEGACY_CLOUD_MIGRATION_KEY = 'legacy_cloud_assets_v1';

export type LegacyMigrationStatus =
  | { status: 'complete'; personas: number; worldbooks: number }
  | { status: 'not_applicable' };

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = (await response.json()) as unknown;
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Fetch first, then merge everything in one IndexedDB transaction. A failed network
 * request therefore leaves neither partial assets nor a false completion marker.
 */
export async function migrateLegacyCloudAssets(
  fetcher: typeof fetch = fetch
): Promise<LegacyMigrationStatus> {
  const completed = await getMeta<LegacyMigrationStatus>(
    LEGACY_CLOUD_MIGRATION_KEY
  );
  if (completed) return completed;

  const [personaResponse, worldbookResponse] = await Promise.all([
    fetcher('/v1/personas', { credentials: 'include' }),
    fetcher('/v1/worldbooks', { credentials: 'include' })
  ]);
  if (personaResponse.status === 404 && worldbookResponse.status === 404) {
    const result: LegacyMigrationStatus = { status: 'not_applicable' };
    await mutateLocalAssets(['meta'], (transaction) => {
      transaction.objectStore('meta').put({
        key: LEGACY_CLOUD_MIGRATION_KEY,
        value: result
      });
    });
    return result;
  }
  if (
    (!personaResponse.ok && personaResponse.status !== 404) ||
    (!worldbookResponse.ok && worldbookResponse.status !== 404)
  ) {
    throw new Error(t().localAssets.legacyAssetsReadFailed);
  }

  const [personaPayload, worldbookPayload]: [
    Record<string, unknown>,
    Record<string, unknown>
  ] = await Promise.all([
    personaResponse.status === 404
      ? Promise.resolve({} as Record<string, unknown>)
      : responseJson(personaResponse),
    worldbookResponse.status === 404
      ? Promise.resolve({} as Record<string, unknown>)
      : responseJson(worldbookResponse)
  ]);
  const legacyPersonas = Array.isArray(personaPayload.personas)
    ? personaPayload.personas
    : [];
  const legacyBooks = Array.isArray(worldbookPayload.worldbooks)
    ? worldbookPayload.worldbooks
    : [];
  const bookDetails = await Promise.all(
    legacyBooks.map(async (item) => {
      const source =
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {};
      const id = typeof source.worldbook_id === 'string' ? source.worldbook_id : '';
      if (!id) return null;
      const response = await fetcher(`/v1/worldbooks/${id}`, {
        credentials: 'include'
      });
  if (!response.ok) {
    throw new Error(t().localAssets.legacyWorldbooksReadFailed);
  }
      return { legacyId: id, payload: await responseJson(response) };
    })
  );

  const [existingPersonas, existingBooks, existingDefault] = await Promise.all([
    getAllLocalRecords<PersonaAsset>('personas'),
    getAllLocalRecords<WorldbookAsset>('worldbooks'),
    getMeta<string>('default_persona_id')
  ]);
  const personaLegacyIds = new Set(
    existingPersonas.map((item) => item.legacy_cloud_id).filter(Boolean)
  );
  const bookLegacyIds = new Set(
    existingBooks.map((item) => item.legacy_cloud_id).filter(Boolean)
  );
  const timestamp = nowIso();
  const personas: PersonaAsset[] = legacyPersonas.flatMap((item) => {
    const source =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
    const legacyId =
      typeof source.persona_id === 'string' ? source.persona_id : '';
    if (!legacyId || personaLegacyIds.has(legacyId)) return [];
    return [
      {
        persona_id: createId(),
        name: typeof source.name === 'string' ? source.name : '',
        description:
          typeof source.description === 'string' ? source.description : '',
        title: '',
        position: 'IN_PROMPT',
        depth: null,
        role: 'system',
        lorebook: null,
        connections: [],
        avatar_name: null,
        avatar_missing: true,
        legacy_cloud_id: legacyId,
        source_fields: source,
        created_at: timestamp,
        updated_at: timestamp
      }
    ];
  });
  const legacyDefaultId = legacyPersonas.find((item) => {
    const source =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
    return source.is_default === true;
  });
  const defaultLegacyId =
    legacyDefaultId && typeof legacyDefaultId === 'object'
      ? String(
          (legacyDefaultId as Record<string, unknown>).persona_id ?? ''
        )
      : '';
  const migratedDefault = personas.find(
    (item) => item.legacy_cloud_id === defaultLegacyId
  );

  const books: WorldbookAsset[] = [];
  const entries: WorldbookEntryAsset[] = [];
  for (const detail of bookDetails) {
    if (!detail || bookLegacyIds.has(detail.legacyId)) continue;
    const rawBook =
      detail.payload.worldbook && typeof detail.payload.worldbook === 'object'
        ? (detail.payload.worldbook as Record<string, unknown>)
        : detail.payload;
    const rawEntries = Array.isArray(detail.payload.entries)
      ? detail.payload.entries
      : [];
    const draft = worldbookDraftFromData(
      { ...rawBook, entries: rawEntries },
      typeof rawBook.name === 'string'
        ? rawBook.name
        : t().localAssets.legacyWorldbookName
    );
    if (!draft) continue;
    const id = createId();
    books.push({
      worldbook_id: id,
      name: draft.name,
      description: draft.description ?? '',
      enabled: rawBook.enabled !== false,
      scan_depth: draft.scan_depth ?? null,
      token_budget: draft.token_budget ?? null,
      recursive_scanning: draft.recursive_scanning ?? true,
      origin: 'LEGACY_CLOUD',
      source_character_id: null,
      legacy_cloud_id: detail.legacyId,
      ...(draft.source_fields ? { source_fields: draft.source_fields } : {}),
      created_at: timestamp,
      updated_at: timestamp
    });
    entries.push(
      ...(draft.entries ?? []).map((entry) => ({
        ...entry,
        worldbook_id: id
      }))
    );
  }

  const result: LegacyMigrationStatus = {
    status: 'complete',
    personas: personas.length,
    worldbooks: books.length
  };
  await mutateLocalAssets(
    ['personas', 'worldbooks', 'worldbook_entries', 'meta'],
    (transaction) => {
      for (const persona of personas) transaction.objectStore('personas').put(persona);
      for (const book of books) transaction.objectStore('worldbooks').put(book);
      for (const entry of entries) {
        transaction.objectStore('worldbook_entries').put(entry);
      }
      if (!existingDefault && migratedDefault) {
        transaction.objectStore('meta').put({
          key: 'default_persona_id',
          value: migratedDefault.persona_id
        });
      }
      transaction.objectStore('meta').put({
        key: LEGACY_CLOUD_MIGRATION_KEY,
        value: result
      });
    }
  );
  return result;
}
