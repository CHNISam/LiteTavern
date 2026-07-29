import { describe, expect, it } from 'vitest';
import { publicRouteForPath, siteHref } from './public-routing';

describe('public routing', () => {
  it('recognizes support and about routes without matching arbitrary suffixes', () => {
    expect(publicRouteForPath('/support', '/')).toBe('support');
    expect(publicRouteForPath('/about/', '/')).toBe('about');
    expect(publicRouteForPath('/not-support', '/')).toBeNull();
  });

  it('does not route operator surfaces from the open client', () => {
    // The Cloud operator console is served by the closed API. If this ever resolves,
    // the admin surface has leaked back into the open, forkable web bundle.
    expect(publicRouteForPath('/alpha-admin', '/')).toBeNull();
  });

  it('supports static deployments under a base path', () => {
    expect(publicRouteForPath('/LiteTavern/support', '/LiteTavern/')).toBe('support');
    expect(siteHref('/support', '/LiteTavern/')).toBe('/LiteTavern/support');
  });
});
