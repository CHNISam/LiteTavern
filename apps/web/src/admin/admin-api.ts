import { cloudUrl } from '../lib/runtime-config';

let adminToken = '';

export function readAdminToken(): string {
  return adminToken;
}

export function saveAdminToken(token: string): void {
  adminToken = token.trim();
}

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export async function adminApi<T>(
  path: `/api/admin/${string}`,
  init: RequestInit = {}
): Promise<T> {
  const token = readAdminToken();
  const response = await fetch(cloudUrl(path), {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      'x-litetavern-admin-token': token,
      ...init.headers
    }
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    throw new AdminApiError(
      payload.error?.message ?? `管理接口请求失败（${response.status}）`,
      response.status,
      payload.error?.code
    );
  }
  return payload as T;
}
