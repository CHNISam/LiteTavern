import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type LiteTavernDatabase } from '@litetavern/database';
import { providerRegistry } from '@litetavern/contracts';
import { ConnectionRepository } from './connection-repository.js';
import { ConnectionRuntime } from './connection-runtime.js';
import { MemoryCredentialStore } from './credential-store.js';
import { AuthLifecycleRegistry, CredentialLifecycle } from './credential-lifecycle.js';
import {
  RuntimeAdapterRegistry,
  type RuntimeAdapter
} from './runtime-adapter.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let database: LiteTavernDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

function adapter(id: string): RuntimeAdapter {
  return {
    id,
    async validate() {
      return { status: 'connected' };
    },
    async listModels() {
      return [{ id: `${id}-model`, displayName: id, capabilities: ['text'] }];
    },
    async stream() {
      throw new Error('not used');
    },
    async complete(context) {
      return `${id}:${context.credential ? decoder.decode(context.credential.payload) : 'external'}`;
    }
  };
}

describe('ConnectionRuntime', () => {
  it('routes API key and Codex connections through different adapters', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    await database.exec(`
      INSERT INTO app_user (user_id)
      VALUES ('00000000-0000-4000-8000-000000000001')
    `);
    const connections = new ConnectionRepository(database);
    const apiConnection = await connections.create({
      userId: '00000000-0000-4000-8000-000000000001',
      providerId: 'openai',
      authMethodId: 'api-key',
      displayName: 'Work API',
      status: 'connected',
      nonSecretConfig: {}
    });
    const codexConnection = await connections.create({
      userId: '00000000-0000-4000-8000-000000000001',
      providerId: 'openai',
      authMethodId: 'codex-cli',
      displayName: 'Personal Codex',
      status: 'connected',
      nonSecretConfig: {}
    });
    const store = new MemoryCredentialStore();
    const credentialRef = `connection:${apiConnection.id}`;
    await store.save(credentialRef, encoder.encode('api-secret'));
    await connections.saveCredentialMetadata({
      credentialRef,
      connectionId: apiConnection.id,
      kind: 'api_key',
      store: 'os_keyring',
      version: 1
    });
    const lifecycle = new CredentialLifecycle({
      store,
      connections,
      handlers: new AuthLifecycleRegistry()
    });
    const runtime = new ConnectionRuntime({
      providers: providerRegistry,
      connections,
      adapters: new RuntimeAdapterRegistry([
        adapter('openai-api'),
        adapter('openai-codex-app-server')
      ]),
      lifecycle
    });

    await expect(
      runtime.complete(
        '00000000-0000-4000-8000-000000000001',
        apiConnection.id,
        { modelId: 'gpt-5', system: '', messages: [] }
      )
    ).resolves.toBe('openai-api:api-secret');
    await expect(
      runtime.complete(
        '00000000-0000-4000-8000-000000000001',
        codexConnection.id,
        { modelId: 'codex', system: '', messages: [] }
      )
    ).resolves.toBe('openai-codex-app-server:external');
  });
});
