/* global Response, URL */

/**
 * The complete set of browser paths owned by LiteTavern Cloud.
 *
 * Both hosted environments import this module. Keeping one routing table prevents
 * development and production from silently assigning the same API to different
 * repositories.
 */
export function isCloudPath(pathname) {
  return pathname.startsWith('/v1/') || pathname.startsWith('/api/admin/');
}

export function forwardCloudRequest(request, env) {
  if (!isCloudPath(new URL(request.url).pathname)) return null;

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

  // Preserve the Request object: cookie, streaming body and response semantics
  // belong to Cloud. This gateway never parses authentication or business data.
  return env.CLOUD.fetch(request);
}
