import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, MIGRATION_SQL, type PomChatDatabase } from './index.js';

let database: PomChatDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(async () => {
  await database?.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  database = undefined;
  temporaryDirectory = undefined;
});

describe('database migration', () => {
  it('creates missing parent directories on first persistent startup', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'pomchat-db-'));
    const dataDir = join(temporaryDirectory, 'nested', 'database');
    database = await createDatabase({ dataDir });
    expect((await database.query('SELECT 1 AS ready')).rows).toHaveLength(1);
  });

  it('creates the modular monolith core tables', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );

    const tables = result.rows.map((row) => row.table_name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'app_user',
        'app_user_identity',
        'agent_character',
        'chat_conversation',
        'chat_message',
        'agent_generation_request',
        'agent_memory',
        'model_configuration',
        'model_usage_ledger',
        'system_postprocess_job'
      ])
    );
  });

  it('upgrades an unversioned database without losing data or reapplying migrations', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'pomchat-db-'));
    const dataDir = join(temporaryDirectory, 'legacy');
    const legacyDatabase = await PGlite.create(dataDir);
    await legacyDatabase.exec(MIGRATION_SQL);
    await legacyDatabase.exec(`
      INSERT INTO app_user (user_id)
      VALUES ('00000000-0000-4000-8000-000000000001')
    `);
    await legacyDatabase.close();

    database = await createDatabase({ dataDir });
    expect(
      (
        await database.query<{ user_id: string }>(
          `SELECT user_id FROM app_user
           WHERE user_id = '00000000-0000-4000-8000-000000000001'`
        )
      ).rows
    ).toHaveLength(1);
    expect(
      (
        await database.query<{ version: number; name: string }>(
          `SELECT version, name
           FROM system_schema_migration
           ORDER BY version`
        )
      ).rows
    ).toEqual([{ version: 1, name: 'initial_schema' }]);

    await database.close();
    database = await createDatabase({ dataDir });
    expect(
      (
        await database.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM system_schema_migration
           WHERE version = 1`
        )
      ).rows
    ).toEqual([{ count: 1 }]);
  });

  it('does not create server-side credential storage', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'model_credential'`
    );
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'model_configuration'`
    );

    expect(tables.rows).toHaveLength(0);
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(['api_key', 'ciphertext', 'secret'])
    );
  });

  it('keeps platform and BYOK usage modes explicit', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    await expect(
      database.exec(`
        INSERT INTO model_usage_ledger (
          usage_id, generation_request_id, user_id, usage_mode,
          provider, model_name, status
        ) VALUES (
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
          'MIXED', 'test', 'test', 'RESERVED'
        )
      `)
    ).rejects.toThrow();
  });
});
