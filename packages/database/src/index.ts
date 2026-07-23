import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MIGRATION_SQL } from './migration.js';

export type PomChatDatabase = PGlite;

export interface CreateDatabaseOptions {
  dataDir?: string;
}

export async function createDatabase(
  options: CreateDatabaseOptions = {}
): Promise<PomChatDatabase> {
  const dataDir = options.dataDir ?? 'memory://';
  if (!dataDir.startsWith('memory://')) await mkdir(dirname(dataDir), { recursive: true });
  const database = await PGlite.create(dataDir);
  await database.exec(MIGRATION_SQL);
  return database;
}

export { MIGRATION_SQL } from './migration.js';
