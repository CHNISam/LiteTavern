import { describe, expect, it } from 'vitest';
import { createId } from './id';

describe('createId', () => {
  it('creates an RFC 4122 v4 id when randomUUID is unavailable', () => {
    const id = createId({
      getRandomValues<T extends Exclude<BufferSource, ArrayBuffer>>(array: T): T {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        bytes.forEach((_, index) => { bytes[index] = index; });
        return array;
      }
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
