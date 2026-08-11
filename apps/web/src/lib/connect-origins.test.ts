import { describe, expect, it } from 'vitest';
import { buildConnectOrigins, parsePublicOrigins } from './connect-origins';

const BUILTINS = ['https://api.openai.com', 'https://api.anthropic.com'] as const;

describe('parsePublicOrigins', () => {
  it('normalizes, deduplicates, and rejects non-HTTP build entries', () => {
    expect(parsePublicOrigins(
      'https://api.example.com/v1, https://api.example.com/elsewhere',
      'javascript:alert(1) invalid http://127.0.0.1:8787/path'
    )).toEqual(['https://api.example.com', 'http://127.0.0.1:8787']);
  });
});

// The CSP half of the BYOK origin policy. A configured origin that reaches
// `import.meta.env` but not this list produces a page that accepts the provider
// in the form and then has the request blocked by `connect-src` — so both halves
// must read the same build-time variables.
describe('buildConnectOrigins', () => {
  it('keeps the built-in provider origins when nothing is configured', () => {
    expect(buildConnectOrigins({}, BUILTINS)).toEqual([...BUILTINS]);
  });

  it('adds the configured BYOK and Cloud origins to the built-in ones', () => {
    expect(buildConnectOrigins(
      {
        VITE_CLOUD_BASE_URL: 'https://cloud.example.test',
        VITE_BYOK_CONNECT_ORIGINS: 'https://api.oaipro.com https://models.example.test/v1'
      },
      BUILTINS
    )).toEqual([
      'https://cloud.example.test',
      'https://api.oaipro.com',
      'https://models.example.test',
      ...BUILTINS
    ]);
  });

  it('drops unusable configured entries without dropping the built-in ones', () => {
    expect(buildConnectOrigins(
      { VITE_BYOK_CONNECT_ORIGINS: 'not-a-url javascript:alert(1)' },
      BUILTINS
    )).toEqual([...BUILTINS]);
  });
});
