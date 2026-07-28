import { describe, expect, it } from 'vitest';
import { publicRouteForPath, siteHref } from './public-routing';

describe('public routing', () => {
  it('recognizes support and about routes without matching arbitrary suffixes', () => {
    expect(publicRouteForPath('/support', '/')).toBe('support');
    expect(publicRouteForPath('/about/', '/')).toBe('about');
    expect(publicRouteForPath('/not-support', '/')).toBeNull();
  });

  it('supports static deployments under a base path', () => {
    expect(publicRouteForPath('/LiteTavern/support', '/LiteTavern/')).toBe('support');
    expect(siteHref('/support', '/LiteTavern/')).toBe('/LiteTavern/support');
  });
});
