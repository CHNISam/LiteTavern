import { describe, expect, it } from 'vitest';
import { cloneJson } from './json-clone';

describe('cloneJson', () => {
  it('deep-copies JSON storage values without relying on structuredClone', () => {
    const source = { name: 'Firefly', tags: ['local'], nested: { enabled: true } };

    const copy = cloneJson(source);

    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.tags).not.toBe(source.tags);
    expect(copy.nested).not.toBe(source.nested);
  });
});
