import { BUILTIN_BYOK_ORIGINS } from './byok-origins';
import { parsePublicOrigins } from './connect-origins';

export type ByokCompatibilityCode =
  | 'BYOK_INVALID_URL'
  | 'BYOK_MIXED_CONTENT'
  | 'BYOK_ORIGIN_NOT_ALLOWED';

export class ByokCompatibilityError extends Error {
  readonly retryable = false;

  constructor(readonly code: ByokCompatibilityCode, message: string) {
    super(message);
    this.name = 'ByokCompatibilityError';
  }
}

function configuredOrigins(raw: string | undefined): Set<string> {
  return new Set(parsePublicOrigins(raw));
}

export function validateByokBaseUrl(
  rawUrl: string,
  options: { pageProtocol?: string; extraOrigins?: string | undefined } = {}
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ByokCompatibilityError('BYOK_INVALID_URL', 'The provider URL is invalid.');
  }
  if (url.protocol !== 'https:' && options.pageProtocol !== 'http:') {
    throw new ByokCompatibilityError(
      'BYOK_MIXED_CONTENT',
      'This page cannot connect to an insecure provider URL.'
    );
  }
  const allowed = new Set([
    ...BUILTIN_BYOK_ORIGINS,
    ...configuredOrigins(options.extraOrigins)
  ]);
  if (!allowed.has(url.origin)) {
    throw new ByokCompatibilityError(
      'BYOK_ORIGIN_NOT_ALLOWED',
      'This provider origin is not enabled in this LiteTavern build.'
    );
  }
  return url;
}

export function publicByokOrigins(): string | undefined {
  return import.meta.env?.VITE_BYOK_CONNECT_ORIGINS as string | undefined;
}
