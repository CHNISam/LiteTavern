/**
 * Worker for the internal (development) deployment: serves the static bundle and
 * the internal `/v1/` API. Copied into the build output *only* for internal
 * deploys:
 *
 *   cp deploy/internal-gate/_worker.js deploy/internal-gate/api.js apps/web/dist/
 *   wrangler pages deploy --branch develop --cwd deploy/internal-gate
 *
 * Production deploys never copy it, so litetavern.pages.dev stays purely static —
 * no Worker invocation per asset, no shared request quota consumed.
 *
 * This file holds no authentication. Who may reach this deployment is decided by
 * the Cloudflare Access application in front of litetavern-dev.pages.dev and
 * *.litetavern-dev.pages.dev, which authenticates real people against an email
 * allow-list before a request ever reaches the origin. An earlier HTTP Basic gate
 * lived here as a stopgap; keeping it would have meant a second login prompt for
 * humans and a shared secret for the `/v1/` fetches, while adding nothing Access
 * does not already do.
 */

import {
  D1Repository,
  R2ObjectStorage,
  handleApiRequest
} from './api.js';

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

/**
 * Paths owned by LiteTavern Cloud, forwarded verbatim to the Cloud Worker.
 *
 * Accounts, Alpha seats, quota and provider credentials are Cloud business and
 * live in the Cloud repository. This file only decides *where a request goes*: it
 * never reads a body, checks an entitlement, counts a quota or touches a
 * credential. Adding any of that here would be reimplementing Cloud inside the
 * open-source client, which is exactly what the repository boundary forbids.
 *
 * The forward keeps the browser same-origin, so the HttpOnly session cookie stays
 * first-party and survives iOS Safari's tracking prevention. A redirect or a
 * cross-origin fetch to a workers.dev hostname would not.
 */
export function isCloudPath(pathname) {
  return (
    pathname.startsWith('/v1/auth/') ||
    pathname === '/v1/cloud/status' ||
    // The BYOK provider catalogue decides which endpoint a provider id may
    // reach, and the connection check calls that endpoint with the reader's
    // key. Both are model-gateway concerns, so both belong to Cloud — this
    // deployment once answered the catalogue itself with an empty list, which
    // rendered as "provider catalogue is empty, check LiteTavern Cloud", a
    // message blaming Cloud for a stub in this file.
    pathname === '/v1/providers' ||
    pathname === '/v1/provider-connections/validate' ||
    /^\/v1\/conversations\/[^/]+\/generations$/.test(pathname)
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isCloudPath(url.pathname)) {
      if (!env.CLOUD) {
        return new Response(JSON.stringify({
          error: {
            code: 'CLOUD_BINDING_MISSING',
            message: 'LiteTavern Cloud 尚未接入本环境。',
            retryable: true
          }
        }), {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow'
          }
        });
      }
      // Pass the request object through untouched — headers, cookies, body and
      // the streaming response all belong to Cloud.
      return env.CLOUD.fetch(request);
    }

    if (url.pathname.startsWith('/v1/')) {
      if (!env.DB || !env.ASSETS_BUCKET) {
        return new Response(JSON.stringify({
          error: {
            code: 'INTERNAL_API_MISCONFIGURED',
            message: '内测 API 尚未完成配置。',
            retryable: true
          }
        }), {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json; charset=utf-8',
            'X-Robots-Tag': 'noindex, nofollow'
          }
        });
      }
      return handleApiRequest(request, {
        repository: new D1Repository(env.DB),
        objects: new R2ObjectStorage(env.ASSETS_BUCKET)
      });
    }

    const response = await serveAssets(request, env);
    const gated = new Response(response.body, response);
    gated.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return gated;
  }
};
