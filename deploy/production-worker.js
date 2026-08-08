/* global Response, URL */

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
    const cloudResponse = forwardCloudRequest(request, env);
    if (cloudResponse) return cloudResponse;
    return serveAssets(request, env);
  }
};
