// Static Pages routes. /admin contains only a lazy-loaded UI shell; every datum and
// mutation remains protected by the Cloud API's server-side administrator gate.
export type PublicRoute = 'support' | 'about' | 'admin';

function normalizedBase(base: string): string {
  const withLeadingSlash = base.startsWith('/') ? base : `/${base}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function siteHref(path: string, base = import.meta.env.BASE_URL): string {
  return `${normalizedBase(base)}${path.replace(/^\/+/, '')}`;
}

export function publicRouteForPath(
  pathname: string,
  base = import.meta.env.BASE_URL
): PublicRoute | null {
  const prefix = normalizedBase(base);
  const relative =
    prefix === '/'
      ? pathname
      : pathname.startsWith(prefix)
        ? `/${pathname.slice(prefix.length)}`
        : pathname;
  const normalized = relative.length > 1 ? relative.replace(/\/+$/, '') : relative;
  if (normalized === '/support') return 'support';
  if (normalized === '/about') return 'about';
  if (normalized === '/admin' || normalized.startsWith('/admin/')) return 'admin';
  return null;
}
