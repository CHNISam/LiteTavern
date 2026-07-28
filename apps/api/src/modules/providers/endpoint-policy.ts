import { isIP } from 'node:net';
import { getProviderRuntimePreset } from '@litetavern/contracts';
import { AppError } from '../../lib/errors.js';

function invalid(): never {
  throw new AppError('MODEL_CONFIGURATION_INVALID', '模型服务地址不符合要求。', 400);
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  if (isIP(host) === 6) {
    if (host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(host) || host.startsWith('ff') || host.startsWith('2001:db8:')) return true;
    if (host.startsWith('::ffff:')) return isPrivateHostname(host.slice('::ffff:'.length));
    return false;
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 198 && [18, 19].includes(parts[1] ?? -1)) ||
    (parts[0] ?? 0) >= 224
  );
}

function normalized(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveProviderEndpoint(providerId: string, requestedBaseUrl: string): string {
  let preset;
  try {
    preset = getProviderRuntimePreset(providerId);
  } catch {
    return invalid();
  }
  if (providerId === 'demo') return '';
  let url: URL;
  try {
    url = new URL(requestedBaseUrl);
  } catch {
    return invalid();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalid();
  }
  const endpoint = normalized(url.toString());
  if (!preset.allowCustomBaseUrl && endpoint !== normalized(preset.baseUrl)) return invalid();
  if (
    isPrivateHostname(url.hostname) &&
    preset.region !== 'LOCAL'
  ) {
    return invalid();
  }
  return endpoint;
}
