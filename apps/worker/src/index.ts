export interface WorkerEnv {
  BACKEND_ORIGIN: string;
  POMCHAT_WEB_ORIGIN: string;
  POMCHAT_MODEL_PROXY_TOKEN: string;
  POMCHAT_PLATFORM_API_KEY?: string;
}

type FetchImplementation = (input: Request) => Promise<Response>;

interface ProviderRequestEnvelope {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | null;
  credentialSource: 'BROWSER_LOCAL' | 'PLATFORM_MANAGED';
}

const PLATFORM_SENTINEL = '__POMCHAT_PLATFORM_MANAGED__';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function jsonError(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message, retryable: false } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      }
    }
  );
}

function constantTimeEqual(left: string, right: string) {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized === '::1'
  ) return true;

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }

  return normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb');
}

function validateProviderUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    isPrivateHostname(url.hostname)
  ) return null;
  return url;
}

function applyPlatformCredential(
  envelope: ProviderRequestEnvelope,
  url: URL,
  headers: Headers,
  platformApiKey: string
) {
  for (const [name, value] of headers) {
    if (value.includes(PLATFORM_SENTINEL)) {
      headers.set(name, value.replaceAll(PLATFORM_SENTINEL, platformApiKey));
    }
  }
  for (const [name, value] of url.searchParams) {
    if (value.includes(PLATFORM_SENTINEL)) {
      url.searchParams.set(name, value.replaceAll(PLATFORM_SENTINEL, platformApiKey));
    }
  }
}

async function handleProviderProxy(
  request: Request,
  env: WorkerEnv,
  fetchImpl: FetchImplementation
) {
  const authorization = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env.POMCHAT_MODEL_PROXY_TOKEN}`;
  if (!env.POMCHAT_MODEL_PROXY_TOKEN || !constantTimeEqual(authorization, expected)) {
    return jsonError(401, 'UNAUTHORIZED', 'Unauthorized.');
  }

  let envelope: ProviderRequestEnvelope;
  try {
    envelope = await request.json() as ProviderRequestEnvelope;
  } catch {
    return jsonError(400, 'INVALID_PROXY_REQUEST', 'Invalid provider request.');
  }
  if (
    !envelope ||
    !Array.isArray(envelope.headers) ||
    !['BROWSER_LOCAL', 'PLATFORM_MANAGED'].includes(envelope.credentialSource)
  ) {
    return jsonError(400, 'INVALID_PROXY_REQUEST', 'Invalid provider request.');
  }

  const url = validateProviderUrl(envelope.url);
  if (!url) return jsonError(400, 'UNSAFE_PROVIDER_URL', 'Provider URL is not allowed.');

  const headers = new Headers();
  for (const pair of envelope.headers) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string'
    ) {
      return jsonError(400, 'INVALID_PROXY_REQUEST', 'Invalid provider request.');
    }
    if (!HOP_BY_HOP_HEADERS.has(pair[0].toLowerCase())) headers.append(pair[0], pair[1]);
  }

  if (envelope.credentialSource === 'PLATFORM_MANAGED') {
    if (!env.POMCHAT_PLATFORM_API_KEY) {
      return jsonError(
        503,
        'PLATFORM_NOT_CONFIGURED',
        'PomChat 官方额度暂未配置，请使用自带模型。'
      );
    }
    applyPlatformCredential(envelope, url, headers, env.POMCHAT_PLATFORM_API_KEY);
  } else if (
    envelope.url.includes(PLATFORM_SENTINEL) ||
    [...headers.values()].some((value) => value.includes(PLATFORM_SENTINEL))
  ) {
    return jsonError(400, 'INVALID_CREDENTIAL_SOURCE', 'Invalid credential source.');
  }

  const method = String(envelope.method || 'GET').toUpperCase();
  const response = await fetchImpl(
    new Request(url, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: envelope.body }),
      redirect: 'manual'
    })
  );
  const responseHeaders = new Headers(response.headers);
  for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

function corsHeaders(origin: string, env: WorkerEnv) {
  const headers = new Headers({
    Vary: 'Origin',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400'
  });
  if (origin === env.POMCHAT_WEB_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

async function handlePublicProxy(
  request: Request,
  env: WorkerEnv,
  fetchImpl: FetchImplementation
) {
  const origin = request.headers.get('origin') ?? '';
  if (request.method === 'OPTIONS') {
    if (origin !== env.POMCHAT_WEB_ORIGIN) {
      return jsonError(403, 'CORS_ORIGIN_REJECTED', 'Origin is not allowed.');
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
  }

  const backend = new URL(env.BACKEND_ORIGIN);
  const incoming = new URL(request.url);
  backend.pathname = incoming.pathname;
  backend.search = incoming.search;
  const response = await fetchImpl(new Request(backend, request));
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin, env);
  for (const [name, value] of cors) headers.set(name, value);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  fetchImpl: FetchImplementation = fetch
) {
  const url = new URL(request.url);
  if (url.pathname === '/internal/provider') {
    if (request.method !== 'POST') {
      return jsonError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    }
    return handleProviderProxy(request, env, fetchImpl);
  }
  if (url.pathname === '/health' || url.pathname.startsWith('/v1/')) {
    return handlePublicProxy(request, env, fetchImpl);
  }
  return jsonError(404, 'NOT_FOUND', 'Not found.');
}

export default {
  fetch(request: Request, env: WorkerEnv) {
    return handleWorkerRequest(request, env);
  }
};
