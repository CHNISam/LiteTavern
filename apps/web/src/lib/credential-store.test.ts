import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserCredentialStore } from './credential-store';

describe('BrowserCredentialStore', () => {
  beforeEach(async () => {
    localStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('litetavern-credentials-test');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  });

  it('keeps the full API key in IndexedDB and exposes only a mask in listings', async () => {
    const store = new BrowserCredentialStore('litetavern-credentials-test');
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
    const store = new BrowserCredentialStore('litetavern-credentials-test');
    const saved = await store.save({ provider: 'moonshot', label: 'Kimi', apiKey: 'old-secret' });
    await store.update(saved.credentialId, 'new-secret');

    expect(await store.readSecret(saved.credentialId)).toBe('new-secret');
    expect((await store.list())[0]?.credentialId).toBe(saved.credentialId);
  });

  it('deletes the local key completely', async () => {
    const store = new BrowserCredentialStore('litetavern-credentials-test');
    const saved = await store.save({ provider: 'zhipu', label: 'GLM', apiKey: 'delete-me' });
    await store.remove(saved.credentialId);

    expect(await store.readSecret(saved.credentialId)).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
