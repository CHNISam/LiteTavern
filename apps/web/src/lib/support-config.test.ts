import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AFDIAN_URL,
  normalizeSupportPlacement,
  normalizeSupportSource,
  resolveSupportConfig,
  safePublicUrl
} from './support-config';

describe('support configuration', () => {
  it.each(['bilibili', 'douyin', 'github', 'website', 'other'] as const)(
    'accepts the known source %s',
    (source) => {
      expect(normalizeSupportSource(source)).toBe(source);
    }
  );

  it('safely normalizes unknown or missing sources and placements', () => {
    expect(normalizeSupportSource('<img src=x onerror=alert(1)>')).toBe('other');
    expect(normalizeSupportSource(null)).toBe('other');
    expect(normalizeSupportPlacement('footer')).toBe('footer');
    expect(normalizeSupportPlacement('untrusted-placement')).toBe('direct');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'file:///private/account.png',
    'vbscript:msgbox(1)'
  ])('rejects the dangerous URL %s', (value) => {
    expect(safePublicUrl(value, 'https://litetavern.example')).toBeNull();
  });

  it('accepts http(s) URLs and same-origin relative assets', () => {
    expect(
      safePublicUrl('https://static.example/support/afdian.png', 'https://litetavern.example')
    ).toBe('https://static.example/support/afdian.png');
    expect(safePublicUrl('/support/afdian.png', 'https://litetavern.example')).toBe(
      'https://litetavern.example/support/afdian.png'
    );
  });

  it('returns null instead of an unsafe configured link', () => {
    expect(
      resolveSupportConfig(
        { VITE_SUPPORT_AFDIAN_URL: 'javascript:alert(1)' },
        'https://litetavern.example'
      )
    ).toEqual({ afdianUrl: null });
  });

  it('falls back to the published project page only when afdian is unconfigured', () => {
    const resolved = resolveSupportConfig({}, 'https://litetavern.example');

    expect(resolved.afdianUrl).toBe(DEFAULT_AFDIAN_URL);
  });
});
