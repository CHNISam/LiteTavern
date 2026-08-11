export function parsePublicOrigins(...values: Array<string | undefined>): string[] {
  const origins = new Set<string>();
  for (const raw of values) {
    for (const value of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
      } catch {
        // Public build variables are configuration, not user input. Invalid entries
        // are ignored here and remain unavailable at runtime.
      }
    }
  }
  return [...origins];
}

/**
 * The origins the page's CSP `connect-src` must name.
 *
 * BYOK talks to the provider straight from the browser, so an origin the BYOK
 * policy accepts is still unreachable unless it is also in `connect-src`. Both
 * halves read the same build-time variables; this one takes them as a plain
 * record so `vite.config.ts` can pass Vite's `loadEnv` result (which includes
 * `.env` files, unlike `process.env`) and tests can pass a literal.
 */
export function buildConnectOrigins(
  env: Record<string, string | undefined>,
  builtinByokOrigins: readonly string[]
): string[] {
  return parsePublicOrigins(
    env.VITE_CLOUD_BASE_URL,
    env.VITE_BYOK_CONNECT_ORIGINS,
    builtinByokOrigins.join(' ')
  );
}
