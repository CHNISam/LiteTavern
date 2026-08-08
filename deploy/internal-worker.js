/* global Response, URL */

import {
  D1Repository,
  R2ObjectStorage,
  handleApiRequest
} from './internal-gate/api.js';
import { forwardCloudRequest } from './cloud-gateway.js';

async function serveAssets(request, env) {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;
  if (!request.headers.get('Accept')?.includes('text/html')) return response;

  const url = new URL(request.url);
  const fallback = await env.ASSETS.fetch(new URL('/index.html', url.origin));
  return new Response(fallback.body, {
    status: 200,
    headers: fallback.headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cloudResponse = forwardCloudRequest(request, env);
    if (cloudResponse) return cloudResponse;

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
