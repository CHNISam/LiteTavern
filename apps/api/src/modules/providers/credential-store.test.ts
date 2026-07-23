import { describe, expect, it } from 'vitest';
import {
  CredentialVersionConflictError,
  MemoryCredentialStore
} from './credential-store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('MemoryCredentialStore', () => {
  it('saves, reads, atomically updates and deletes arbitrary credential payloads', async () => {
    const store = new MemoryCredentialStore();
    expect(await store.save('credential-1', encoder.encode('{"apiKey":"one"}'))).toEqual({
      version: 1
    });
    expect(decoder.decode((await store.read('credential-1'))?.payload)).toBe(
      '{"apiKey":"one"}'
    );

    expect(
      await store.compareAndSwap(
        'credential-1',
        1,
        encoder.encode('{"accessToken":"two","refreshToken":"rotated"}')
      )
    ).toEqual({ version: 2 });
    await expect(
      store.compareAndSwap('credential-1', 1, encoder.encode('stale'))
    ).rejects.toBeInstanceOf(CredentialVersionConflictError);

    await store.delete('credential-1');
    expect(await store.read('credential-1')).toBeNull();
  });
});
