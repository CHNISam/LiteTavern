/**
 * Password gate for the internal (development) deployment.
 *
 * This file is copied into the build output *only* for internal deploys:
 *
 *   cp deploy/internal-gate/_worker.js apps/web/dist/
 *   wrangler pages deploy apps/web/dist --project-name litetavern-internal --branch develop
 *
 * Production deploys never copy it, so litetavern.pages.dev stays purely static —
 * no Worker invocation per asset, no shared request quota consumed.
 *
 * The gate is HTTP Basic auth against `INTERNAL_PREVIEW_PASSWORD`, a Pages
 * environment secret. The password is never stored in this repository. If the
 * secret is unset the gate opens rather than locking a deployment out of reach:
 * the deliberate failure mode is "open", because this file also ends up in front
 * of a build that may have no secret configured yet.
 *
 * This is an interim measure. It authenticates a shared secret, not a person:
 * no per-user identity, no revoking one collaborator without rotating for all,
 * no audit trail. Cloudflare Access is the real answer.
 */

const REALM = 'LiteTavern internal';

/** Constant-time comparison, so a wrong password leaks no timing signal. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized() {
  return new Response('401 Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
      // An internal build must never reach a search index, gate or no gate.
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

function authorized(request, expected) {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return false;
  }

  // Any username is accepted; only the shared password is checked.
  const separator = decoded.indexOf(':');
  const supplied = separator === -1 ? '' : decoded.slice(separator + 1);
  return timingSafeEqual(supplied, expected);
}

/**
 * Serve the static bundle, falling back to index.html so client-side routes keep
 * working. `_redirects` is not guaranteed to apply once a `_worker.js` takes over
 * asset routing, so the SPA fallback is done here rather than assumed.
 */
async function serveAssets(request, env) {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;

  const url = new URL(request.url);
  // Only HTML navigations fall back; a missing asset should stay a 404.
  if (!request.headers.get('Accept')?.includes('text/html')) return response;

  const fallback = await env.ASSETS.fetch(new URL('/index.html', url.origin));
  return new Response(fallback.body, {
    status: 200,
    headers: fallback.headers
  });
}

export default {
  async fetch(request, env) {
    const expected = env.INTERNAL_PREVIEW_PASSWORD;
    if (expected && !authorized(request, expected)) return unauthorized();

    const response = await serveAssets(request, env);
    const gated = new Response(response.body, response);
    gated.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return gated;
  }
};
