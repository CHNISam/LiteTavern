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
        'world_instance',
        'world_fact',
        'character_knowledge',
        'character_world_state',
        'relationship_change',
        'character_decision',
        'character_decision_fact',
        'model_configuration',
        'model_usage_ledger',
        'free_quota_ledger',
        'analytics_event',
        'provider_connection',
        'provider_credential_metadata',
        'provider_model_catalog',
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
    ).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'provider_connections' },
      { version: 3, name: 'character_card_model' },
      { version: 4, name: 'multi_bubble_turns' },
      { version: 5, name: 'free_quota_analytics' },
      { version: 6, name: 'email_auth' },
      { version: 7, name: 'relationship_import' },
      { version: 8, name: 'causal_world_foundation' },
    ]);

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

  it('separates normalized, passthrough, and source metadata for character cards', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_character_card_version'`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['normalized_data', 'passthrough_data', 'source_metadata'])
    );
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
    const providerColumns = await database.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('provider_connection', 'provider_credential_metadata')
         AND column_name IN (
           'api_key', 'access_token', 'refresh_token', 'token', 'ciphertext', 'secret'
         )`
    );
    expect(providerColumns.rows).toEqual([]);
  });

  it('stores multiple independent connections for the same provider', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    await database.exec(`
      INSERT INTO app_user (user_id)
      VALUES ('00000000-0000-4000-8000-000000000001');

      INSERT INTO provider_connection (
        connection_id, user_id, provider_id, auth_method_id,
        display_name, status, config_json
      ) VALUES
        (
          '10000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000001',
          'openai', 'codex-cli', 'OpenAI personal', 'connected', '{}'::jsonb
        ),
        (
          '10000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000001',
          'openai', 'api-key', 'OpenAI work', 'reconnect_required', '{}'::jsonb
        );
    `);

    const result = await database.query<{
      auth_method_id: string;
      display_name: string;
      status: string;
    }>(
      `SELECT auth_method_id, display_name, status
       FROM provider_connection
       ORDER BY display_name`
    );
    expect(result.rows).toEqual([
      {
        auth_method_id: 'codex-cli',
        display_name: 'OpenAI personal',
        status: 'connected'
      },
      {
        auth_method_id: 'api-key',
        display_name: 'OpenAI work',
        status: 'reconnect_required'
      }
    ]);
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

  it('adds bounded free quota state and indexed analytics dimensions', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const userColumns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'app_user'`
    );
    expect(userColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'free_quota_total',
        'free_quota_remaining',
        'free_quota_reserved',
        'free_quota_granted_at',
        'first_source_channel',
        'first_campaign_id'
      ])
    );

    const analyticsColumns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'analytics_event'`
    );
    expect(analyticsColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'anonymous_id',
        'occurred_at',
        'received_at',
        'page_name',
        'page_path',
        'character_id',
        'conversation_id',
        'campaign_id',
        'schema_version'
      ])
    );
  });
});
