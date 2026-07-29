/**
 * Where the LiteTavern client finds LiteTavern Cloud.
 *
 * LiteTavern is an open-source client that must build to a plain static bundle and
 * run from Cloudflare Pages, GitHub Pages, a custom domain or a sub-path, without
 * assuming it is served from the same origin as the API. The Cloud base URL is
 * therefore resolved at runtime, in this order:
 *
 *   1. `window.__LITETAVERN__.cloudBaseUrl` — set by `public/litetavern-config.js`,
 *      editable after the bundle is built (one deployment, many environments);
 *   2. `VITE_CLOUD_BASE_URL` — baked in at build time;
 *   3. same origin — the default for local development and single-origin hosting.
 *
 * The client never embeds a LiteTavern Cloud platform API key: it only ever holds a
 * session cookie, and BYOK keys stay in the browser.
 */

declare global {
  interface Window {
    __LITETAVERN__?: { cloudBaseUrl?: string };
  }
}

function normalize(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

export function cloudBaseUrl(): string {
  const runtime =
    typeof window === 'undefined' ? '' : normalize(window.__LITETAVERN__?.cloudBaseUrl);
  if (runtime) return runtime;
  return normalize(import.meta.env?.VITE_CLOUD_BASE_URL as string | undefined);
}

/** Absolute URL for an API path, honouring a cross-origin Cloud deployment. */
export function cloudUrl(path: string): string {
  const base = cloudBaseUrl();
  return base ? `${base}${path}` : path;
}

/** True when the client and LiteTavern Cloud live on different origins. */
export function isCrossOriginCloud(): boolean {
  return cloudBaseUrl().length > 0;
}
