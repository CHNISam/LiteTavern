/* global Response, URL */

/**
 * The complete set of browser paths owned by LiteTavern Cloud.
 *
 * Both hosted environments import this module. Keeping one routing table prevents
 * development and production from silently assigning the same API to different
 * repositories.
 */
export function isCloudPath(pathname) {
  return (
    pathname.startsWith('/v1/auth/') ||
    pathname === '/v1/feedback' ||
    pathname === '/v1/cloud/status' ||
    pathname === '/v1/conversations' ||
    /^\/v1\/conversations\/[^/]+\/messages$/.test(pathname) ||
    // The swipe list and the swipe itself. Both read and write `chat_message`, which
    // only Cloud has: answering either here would mean reporting variants of a
    // transcript this deployment does not store.
    /^\/v1\/conversations\/[^/]+\/messages\/[^/]+\/variants$/.test(pathname) ||
    /^\/v1\/conversations\/[^/]+\/messages\/[^/]+\/activate$/.test(pathname) ||
    pathname === '/v1/providers' ||
    pathname === '/v1/provider-connections/validate' ||
    /^\/v1\/conversations\/[^/]+\/generations$/.test(pathname) ||
    // "代写": USER-perspective drafts. It is a model call over the transcript, so it
    // needs both the model gateway and `chat_message` — neither of which this
    // deployment has. Leaving it off this table is what made the button report
    // "内测环境的模型服务尚未启用" on every click: the request never left for Cloud
    // and was answered by the gate's own 503.
    /^\/v1\/conversations\/[^/]+\/reply-suggestions$/.test(pathname)
  );
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
