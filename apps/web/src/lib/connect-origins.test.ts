import { describe, expect, it } from 'vitest';
import { parsePublicOrigins } from './connect-origins';

describe('parsePublicOrigins', () => {
  it('normalizes, deduplicates, and rejects non-HTTP build entries', () => {
    expect(parsePublicOrigins(
      'https://api.example.com/v1, https://api.example.com/elsewhere',
      'javascript:alert(1) invalid http://127.0.0.1:8787/path'
    )).toEqual(['https://api.example.com', 'http://127.0.0.1:8787']);
  });
});
