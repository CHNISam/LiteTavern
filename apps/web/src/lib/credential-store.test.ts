import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserCredentialStore } from './credential-store';

describe('BrowserCredentialStore', () => {
  const currentDatabaseName = 'litetavern-credentials-test';
  const previousDatabaseName = ['pom', 'chat-credentials-test'].join('');

  beforeEach(async () => {
    localStorage.clear();
    await Promise.all(
      [currentDatabaseName, previousDatabaseName].map(
        (databaseName) =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(databaseName);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => resolve();
          })
      )
    );
  });

  it('keeps the full API key in IndexedDB and exposes only a mask in listings', async () => {
    const store = new BrowserCredentialStore(currentDatabaseName);
    const secret = 'sk-browser-only-super-secret';
    const saved = await store.save({ provider: 'deepseek', label: '我的 DeepSeek', apiKey: secret });

    expect(localStorage.getItem(saved.credentialId)).toBeNull();
    expect(JSON.stringify(await store.list())).not.toContain(secret);
    expect((await store.list())[0]).toMatchObject({
      credentialId: saved.credentialId,
      provider: 'deepseek',
      label: '我的 DeepSeek',
      maskedKey: 'sk-b••••cret'
    });
    expect(await store.readSecret(saved.credentialId)).toBe(secret);
  });

  it('updates a key without changing its credential id', async () => {
    const store = new BrowserCredentialStore(currentDatabaseName);
    const saved = await store.save({ provider: 'moonshot', label: 'Kimi', apiKey: 'old-secret' });
    await store.update(saved.credentialId, 'new-secret');

    expect(await store.readSecret(saved.credentialId)).toBe('new-secret');
    expect((await store.list())[0]?.credentialId).toBe(saved.credentialId);
  });

  it('deletes the local key completely', async () => {
    const store = new BrowserCredentialStore(currentDatabaseName);
    const saved = await store.save({ provider: 'zhipu', label: 'GLM', apiKey: 'delete-me' });
    await store.remove(saved.credentialId);

    expect(await store.readSecret(saved.credentialId)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('migrates credentials from the previous database name without exposing secrets', async () => {
    const previousStore = new BrowserCredentialStore(previousDatabaseName);
    const saved = await previousStore.save({
      provider: 'deepseek',
      label: 'Existing key',
      apiKey: 'sk-existing-secret'
    });

    const store = new BrowserCredentialStore(currentDatabaseName, previousDatabaseName);

    expect(await store.readSecret(saved.credentialId)).toBe('sk-existing-secret');
    expect(JSON.stringify(await store.list())).not.toContain('sk-existing-secret');
  });
});
