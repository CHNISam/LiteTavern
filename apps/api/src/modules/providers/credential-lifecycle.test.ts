import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type LiteTavernDatabase } from '@litetavern/database';
import { providerRegistry } from '@litetavern/contracts';
import { ConnectionRepository } from './connection-repository.js';
import { MemoryCredentialStore } from './credential-store.js';
import {
  AuthLifecycleRegistry,
  CredentialLifecycle
} from './credential-lifecycle.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let database: LiteTavernDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function setupExpiredConnection() {
  database = await createDatabase({ dataDir: 'memory://' });
  await database.exec(`
    INSERT INTO app_user (user_id)
    VALUES ('00000000-0000-4000-8000-000000000001')
  `);
  const connections = new ConnectionRepository(database);
  const connection = await connections.create({
    userId: '00000000-0000-4000-8000-000000000001',
    providerId: 'openai',
    authMethodId: 'api-key',
    displayName: 'Work',
    status: 'expired',
    nonSecretConfig: {}
  });
  const store = new MemoryCredentialStore();
  const credentialRef = `connection:${connection.id}`;
  await store.save(
    credentialRef,
    encoder.encode('{"accessToken":"old","refreshToken":"old-refresh"}')
  );
  await connections.saveCredentialMetadata({
    credentialRef,
    connectionId: connection.id,
    kind: 'api_key',
    store: 'os_keyring',
    version: 1,
    expiresAt: '2026-07-22T00:00:00.000Z'
  });
  return { connections, connection, store };
}

describe('CredentialLifecycle', () => {
  it('single-flights concurrent refresh and atomically rotates the credential', async () => {
    const { connections, connection, store } = await setupExpiredConnection();
    const handlers = new AuthLifecycleRegistry();
    const refresh = vi.fn(async () => ({
      payload: encoder.encode('{"accessToken":"new","refreshToken":"rotated"}'),
      expiresAt: '2026-07-24T00:00:00.000Z'
    }));
    handlers.register('openai', 'api-key', {
      async validate() {
        return { status: 'connected' };
      },
      refresh,
      async reconnect() {
        throw new Error('not used');
      }
    });
    const lifecycle = new CredentialLifecycle({
      store,
      connections,
      handlers,
      now: () => new Date('2026-07-23T00:00:00.000Z')
    });
    const authMethod = providerRegistry.getAuthMethod('openai', 'api-key');

    const [first, second] = await Promise.all([
      lifecycle.acquire(connection, authMethod),
      lifecycle.acquire(connection, authMethod)
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(decoder.decode(first?.payload)).toContain('"accessToken":"new"');
    expect(decoder.decode(second?.payload)).toContain('"refreshToken":"rotated"');
    expect((await connections.getCredentialMetadata(connection.id))?.version).toBe(2);
    expect(
      await connections.findOwned(
        '00000000-0000-4000-8000-000000000001',
        connection.id
      )
    ).toMatchObject({ status: 'connected' });
  });

  it('marks the connection reconnect_required when refresh fails', async () => {
    const { connections, connection, store } = await setupExpiredConnection();
    const handlers = new AuthLifecycleRegistry();
    handlers.register('openai', 'api-key', {
      async validate() {
        return { status: 'connected' };
      },
      async refresh() {
        throw new Error('invalid_grant');
      },
      async reconnect() {
        throw new Error('not used');
      }
    });
    const lifecycle = new CredentialLifecycle({
      store,
      connections,
      handlers,
      now: () => new Date('2026-07-23T00:00:00.000Z')
    });

    await expect(
      lifecycle.acquire(
        connection,
        providerRegistry.getAuthMethod('openai', 'api-key')
      )
    ).rejects.toMatchObject({ code: 'CONNECTION_RECONNECT_REQUIRED' });
    expect(
      await connections.findOwned(
        '00000000-0000-4000-8000-000000000001',
        connection.id
      )
    ).toMatchObject({ status: 'reconnect_required' });
  });
});
