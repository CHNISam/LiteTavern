import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type LiteTavernDatabase } from '@litetavern/database';
import { ConnectionRepository } from './connection-repository.js';

let database: LiteTavernDatabase | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function setup() {
  database = await createDatabase({ dataDir: 'memory://' });
  await database.exec(`
    INSERT INTO app_user (user_id)
    VALUES ('00000000-0000-4000-8000-000000000001')
  `);
  return new ConnectionRepository(database);
}

describe('ConnectionRepository', () => {
  it('keeps multiple connections for the same provider independent', async () => {
    const repository = await setup();
    const personal = await repository.create({
      userId: '00000000-0000-4000-8000-000000000001',
      providerId: 'openai',
      authMethodId: 'codex-cli',
      displayName: 'Personal',
      status: 'connected',
      nonSecretConfig: {}
    });
    const work = await repository.create({
      userId: '00000000-0000-4000-8000-000000000001',
      providerId: 'openai',
      authMethodId: 'api-key',
      displayName: 'Work',
      status: 'reconnect_required',
      nonSecretConfig: { organization: 'work' }
    });

    expect(personal.id).not.toBe(work.id);
    expect(await repository.listForUser('00000000-0000-4000-8000-000000000001')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: personal.id, authMethodId: 'codex-cli' }),
        expect.objectContaining({ id: work.id, authMethodId: 'api-key' })
      ])
    );
  });

  it('updates lifecycle metadata and cascades dependent local records on delete', async () => {
    const repository = await setup();
    const connection = await repository.create({
      userId: '00000000-0000-4000-8000-000000000001',
      providerId: 'openai',
      authMethodId: 'api-key',
      displayName: 'Work',
      status: 'connected',
      nonSecretConfig: {}
    });
    await repository.saveCredentialMetadata({
      credentialRef: `connection:${connection.id}`,
      connectionId: connection.id,
      kind: 'api_key',
      store: 'os_keyring',
      version: 1
    });
    await repository.replaceModels(connection.id, [
      { id: 'gpt-5', displayName: 'GPT-5', capabilities: ['text'] }
    ]);
    await repository.updateStatus(connection.id, 'expired', 'ACCESS_TOKEN_EXPIRED');

    expect(
      await repository.findOwned(
        '00000000-0000-4000-8000-000000000001',
        connection.id
      )
    ).toMatchObject({
      status: 'expired',
      lastErrorCode: 'ACCESS_TOKEN_EXPIRED'
    });

    expect(
      await repository.deleteOwned(
        '00000000-0000-4000-8000-000000000001',
        connection.id
      )
    ).toBe(true);
    expect(await repository.getCredentialMetadata(connection.id)).toBeNull();
    expect(await repository.listModels(connection.id)).toEqual([]);
  });
});
