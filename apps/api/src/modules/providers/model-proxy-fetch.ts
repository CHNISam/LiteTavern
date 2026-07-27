import { PLATFORM_MANAGED_CREDENTIAL_SENTINEL } from './credentials.js';

export interface ModelProxyFetchOptions {
  proxyUrl: string;
  proxyToken: string;
  fetchImpl?: typeof fetch;
}

interface ProviderRequestEnvelope {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: string | null;
  credentialSource: 'BROWSER_LOCAL' | 'PLATFORM_MANAGED';
}

function containsPlatformSentinel(url: string, headers: Headers) {
  if (url.includes(PLATFORM_MANAGED_CREDENTIAL_SENTINEL)) return true;
  return [...headers.values()].some((value) =>
    value.includes(PLATFORM_MANAGED_CREDENTIAL_SENTINEL)
  );
}

export function createModelProxyFetch(options: ModelProxyFetchOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? null
      : await request.clone().text();
    const envelope: ProviderRequestEnvelope = {
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      body,
      credentialSource: containsPlatformSentinel(request.url, request.headers)
        ? 'PLATFORM_MANAGED'
        : 'BROWSER_LOCAL'
    };

    return fetchImpl(options.proxyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.proxyToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify(envelope),
      signal: request.signal
    });
  };
}
