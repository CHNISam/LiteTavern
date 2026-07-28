import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migration.js';

export type LiteTavernDatabase = PGlite;

export interface CreateDatabaseOptions {
  dataDir?: string;
}

async function runMigrations(database: LiteTavernDatabase): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS system_schema_migration (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name VARCHAR(100) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const migration of MIGRATIONS) {
    await database.transaction(async (transaction) => {
      const applied = await transaction.query<{ applied: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM system_schema_migration
           WHERE version = $1
         ) AS applied`,
        [migration.version]
      );
      if (applied.rows[0]?.applied) return;

      await transaction.exec(migration.sql);
      await transaction.query(
        `INSERT INTO system_schema_migration (version, name)
         VALUES ($1, $2)`,
        [migration.version, migration.name]
      );
    });
  }
}

export async function createDatabase(
  options: CreateDatabaseOptions = {}
): Promise<LiteTavernDatabase> {
  const dataDir = options.dataDir ?? 'memory://';
  if (!dataDir.startsWith('memory://')) await mkdir(dirname(dataDir), { recursive: true });
  const database = await PGlite.create(dataDir);
  await runMigrations(database);
  return database;
}

export { MIGRATIONS, MIGRATION_SQL } from './migration.js';
