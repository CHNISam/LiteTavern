import { ApiError, api } from './api';

/**
 * LiteTavern Cloud client state.
 *
 * The client renders whatever the server says and nothing more: quota sizes, stage
 * names and the support link all arrive from `/v1/cloud/status`. Nothing about
 * entitlements is decided here.
 *
 * The last successful status is cached so that, when LiteTavern Cloud is unreachable,
 * the UI can say "cloud unavailable, showing the last known state" instead of either
 * lying about the service or claiming the user's data is gone.
 */

export type CloudStage = 'ALPHA' | 'BETA';

export type MembershipStatus =
  | 'ANONYMOUS_TRIAL'
  | 'REGISTERED_WAITLIST'
  // Holds a seat but has not entered yet. Kept distinct from ALPHA_ACTIVE so the
  // panel can offer "enter Alpha" instead of pretending the user is already in.
  | 'ALPHA_GRANTED'
  | 'ALPHA_ACTIVE'
  | 'ALPHA_PAUSED'
  | 'ALPHA_ENDED';

export type QuotaSource = 'TRIAL' | 'ALPHA' | 'BYOK' | 'NONE';

export type CloudNextAction =
  | 'START_CHATTING'
  | 'REGISTER'
  | 'JOIN_WAITLIST'
  | 'WAIT_FOR_ALPHA'
  | 'ENTER_ALPHA'
  | 'USE_BYOK'
  | 'SUPPORT_LITETAVERN';

export interface CloudQuota {
  source: QuotaSource;
  total: number;
  used: number;
  reserved: number;
  available: number;
  remaining_ratio: number;
  cycle_no: number | null;
  cycle_starts_at: string | null;
  cycle_ends_at: string | null;
}

export interface CloudStatus {
  stage: CloudStage;
  platform_models_available: boolean;
  identity_type: 'ANONYMOUS' | 'EMAIL';
  registered: boolean;
  membership_status: MembershipStatus;
  on_waitlist: boolean;
  waitlist_joined_at: string | null;
  alpha_active: boolean;
  alpha_granted: boolean;
  alpha_granted_at: string | null;
  alpha_activated_at: string | null;
  alpha_batch_id: string | null;
  alpha_grant_source: string | null;
  alpha_status_reason: string | null;
  founding_supporter: boolean;
  quota: CloudQuota;
  support: { enabled: boolean; url: string; headline: string; body: string };
  next_actions: CloudNextAction[];
}

const STATUS_CACHE_KEY = 'litetavern.cloud.status.v1';
const DEVICE_KEY = 'litetavern.cloud.device.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCachedStatus(): CloudStatus | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STATUS_CACHE_KEY);
    return raw ? (JSON.parse(raw) as CloudStatus) : null;
  } catch {
    return null;
  }
}

function cacheStatus(status: CloudStatus) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    // A full or blocked storage must never break the product.
  }
}

/** Stable per-browser identifier used only to label sync checkpoints. */
export function deviceKey(): string {
  const store = storage();
  const existing = store?.getItem(DEVICE_KEY);
  if (existing) return existing;
  const generated =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `device-${Math.random().toString(36).slice(2)}`;
  try {
    store?.setItem(DEVICE_KEY, generated);
  } catch {
    /* best effort */
  }
  return generated;
}

export interface CloudStatusResult {
  status: CloudStatus | null;
  /** True when the request failed and `status` (if any) is the cached copy. */
  offline: boolean;
}

/**
 * Fetches the live status, falling back to the cached one when LiteTavern Cloud is
 * unreachable. A cached status is explicitly marked `offline` so the UI can label it
 * as stale rather than presenting it as current service state.
 */
export async function fetchCloudStatus(): Promise<CloudStatusResult> {
  try {
    const response = await api<{ cloud: CloudStatus }>('/v1/cloud/status');
    cacheStatus(response.cloud);
    return { status: response.cloud, offline: false };
  } catch (reason) {
    // A 401 is a real answer (no identity yet), not an outage.
    if (reason instanceof ApiError && reason.code === 'UNAUTHORIZED') throw reason;
    return { status: readCachedStatus(), offline: true };
  }
}

export async function joinAlphaWaitlist(
  channel = 'app'
): Promise<{ joined: boolean; cloud: CloudStatus }> {
  const response = await api<{ joined: boolean; cloud: CloudStatus }>(
    '/v1/cloud/waitlist',
    { method: 'POST', body: JSON.stringify({ channel }) }
  );
  cacheStatus(response.cloud);
  return response;
}

/**
 * Enters Alpha. The server decides whether the caller is allowed to — this only
 * reports the result, and a client that has been suspended gets a plain error back
 * rather than a usable session.
 */
export async function activateAlpha(): Promise<{
  activated: boolean;
  already_active: boolean;
  cloud: CloudStatus;
}> {
  const response = await api<{
    activated: boolean;
    already_active: boolean;
    cloud: CloudStatus;
  }>('/v1/cloud/alpha/activate', { method: 'POST' });
  cacheStatus(response.cloud);
  return response;
}

export async function submitAlphaFeedback(input: {
  title: string;
  detail?: string;
}): Promise<void> {
  await api('/v1/cloud/alpha/feedback', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {})
    })
  });
}

export interface SupportInfo {
  enabled: boolean;
  url: string;
  headline: string;
  body: string;
  thanks_list_enabled: boolean;
  supporter_count: number;
  confirmation: 'MANUAL';
  thanks: { display_name: string; since: string }[];
}

export async function fetchSupportInfo(): Promise<SupportInfo> {
  const response = await api<{ support: SupportInfo }>('/v1/cloud/support');
  return response.support;
}

export type SyncStatus = 'LOCAL' | 'SYNCING' | 'SYNCED' | 'FAILED';

/**
 * Reports how far this device has reconciled. Never throws: a failed checkpoint is
 * itself a sync failure and is simply retried on the next attempt.
 */
export async function reportSyncCheckpoint(input: {
  status: SyncStatus;
  clientRevision?: number;
  pendingCount?: number;
  errorCode?: string;
}): Promise<void> {
  try {
    await api('/v1/cloud/sync/checkpoint', {
      method: 'POST',
      body: JSON.stringify({
        device_key: deviceKey(),
        status: input.status,
        ...(input.clientRevision === undefined
          ? {}
          : { client_revision: input.clientRevision }),
        ...(input.pendingCount === undefined
          ? {}
          : { pending_count: input.pendingCount }),
        ...(input.errorCode ? { error_code: input.errorCode } : {})
      })
    });
  } catch {
    // Reporting sync state must not itself break the session.
  }
}

/** URL of the export endpoint, used for a direct download link. */
export const EXPORT_PATH = '/v1/cloud/export';

// ===== User-facing copy =====
// Kept in one place so the product never overstates what the user actually has.

export function quotaLabel(status: CloudStatus | null): string {
  if (!status) return 'LiteTavern Cloud';
  const { quota } = status;
  if (quota.source === 'ALPHA') {
    return `LiteTavern Cloud Alpha · 本期额度剩余 ${Math.round(
      quota.remaining_ratio * 100
    )}%`;
  }
  if (quota.source === 'TRIAL') {
    return `试用额度剩余 ${quota.available} 次`;
  }
  return '暂无平台额度';
}

export function membershipNotice(status: CloudStatus | null): string | null {
  if (!status) return null;
  switch (status.membership_status) {
    case 'ANONYMOUS_TRIAL':
      return status.quota.available > 0
        ? '正在使用 LiteTavern Cloud 提供的试用额度'
        : 'LiteTavern Cloud 试用额度已用完。注册后可加入 Alpha 候补名单，或切换到自己的模型服务继续聊天。';
    case 'REGISTERED_WAITLIST':
      // No queue position is shown: it moves as people join, leave and are released,
      // so a number here would be a promise the program cannot keep.
      return status.founding_supporter
        ? '已加入 LiteTavern Cloud Alpha 候补名单。感谢你成为 LiteTavern 的早期支持者——你在候补排序中会被优先考虑，但支持本身不等于购买资格，我们也无法承诺确切的开放日期。'
        : '已加入 LiteTavern Cloud Alpha 候补名单。名额有限，我们会按候补顺序逐批开放，暂时无法承诺确切的开放日期。';
    case 'ALPHA_GRANTED':
      return '你已获得 LiteTavern Cloud Alpha 资格，还没有开始使用。进入 Alpha 后即可使用平台额度和云服务。';
    case 'ALPHA_ACTIVE':
      return `LiteTavern Cloud Alpha · 本期额度剩余 ${Math.round(
        status.quota.remaining_ratio * 100
      )}%`;
    case 'ALPHA_PAUSED':
      return status.alpha_status_reason
        ? `LiteTavern Cloud Alpha 访问已暂停：${status.alpha_status_reason}。你可以切换到自己的模型服务继续聊天。`
        : 'LiteTavern Cloud Alpha 访问已暂停。你可以切换到自己的模型服务继续聊天。';
    case 'ALPHA_ENDED':
      return status.alpha_status_reason
        ? `本轮 LiteTavern Cloud Alpha 已结束：${status.alpha_status_reason}。你可以切换到自己的模型服务继续聊天。`
        : '本轮 LiteTavern Cloud Alpha 已结束。你可以切换到自己的模型服务继续聊天。';
    default:
      return null;
  }
}

/** The stage disclaimer. Alpha rules may change; granted cycles are not wiped. */
export const ALPHA_DISCLAIMER =
  'LiteTavern Cloud Alpha 仍处于测试阶段。额度、模型和云服务规则可能根据实际成本、稳定性和测试结果进行调整。';
