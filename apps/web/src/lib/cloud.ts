import { ApiError, api } from './api';
import { t } from './i18n';

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

/**
 * The platform pool, described rather than reduced to a bare number.
 *
 * A lone "剩余 30 次" tells the reader nothing about who is paying, out of how
 * much, or whether it comes back — which is exactly why it read as invented.
 * Every field here comes from `/v1/cloud/status`; nothing is estimated.
 */
export interface QuotaDescription {
  /** The service providing the allowance, named. It is not "官方" — it is a product. */
  provider: string;
  /** Which pool of that service is paying. */
  poolName: string;
  used: number;
  total: number;
  available: number;
  /** 0–1, for a meter. */
  ratio: number;
  /** How the pool comes back, stated even when the answer is "it does not". */
  renewal: string;
  exhausted: boolean;
  /** What one unit buys, in the user's terms. */
  unitName: string;
}

/** The service name is a proper noun, so it comes from the dictionary but never
 *  actually differs — the point is that the copy around it does. */
export function cloudProviderName(): string {
  return t().cloud.providerName;
}

export function describeQuota(status: CloudStatus | null): QuotaDescription | null {
  if (!status || status.quota.source === 'NONE') return null;
  const { quota } = status;
  const alpha = quota.source === 'ALPHA';
  return {
    provider: cloudProviderName(),
    poolName: alpha ? t().cloud.alphaPool : t().cloud.trialPool,
    // `used` is authoritative; deriving it from total - available would hide
    // anything the server has reserved but not yet spent.
    used: quota.used,
    total: quota.total,
    available: quota.available,
    ratio: quota.total > 0 ? quota.available / quota.total : 0,
    renewal: alpha ? t().cloud.alphaRenewal : t().cloud.trialRenewal,
    exhausted: quota.available === 0,
    unitName: t().cloud.replyUnit
  };
}

/** One-line form for compact surfaces such as the composer's mode switch. */
export function quotaLabel(status: CloudStatus | null): string {
  const described = describeQuota(status);
  if (!described) return t().cloud.noQuota(cloudProviderName());
  const daily = status?.quota.source === 'ALPHA';
  return t().cloud.quotaLabel(
    described.provider,
    described.poolName,
    daily ? t().cloud.scopeToday : t().cloud.scopeRemaining,
    described.available,
    described.total
  );
}

export function membershipNotice(status: CloudStatus | null): string | null {
  if (!status) return null;
  switch (status.membership_status) {
    case 'ANONYMOUS_TRIAL':
      return status.quota.available > 0
        ? t().membership.anonymousTrialActive
        : t().membership.anonymousTrialSpent;
    case 'REGISTERED_WAITLIST':
      // No queue position is shown: it moves as people join, leave and are released,
      // so a number here would be a promise the program cannot keep.
      return status.founding_supporter
        ? t().membership.waitlistSupporter
        : t().membership.waitlist;
    case 'ALPHA_GRANTED':
      return t().membership.alphaGranted;
    case 'ALPHA_ACTIVE':
      return t().membership.alphaActive(status.quota.available, status.quota.total);
    case 'ALPHA_PAUSED':
      return status.alpha_status_reason
        ? t().membership.alphaPausedWithReason(status.alpha_status_reason)
        : t().membership.alphaPaused;
    case 'ALPHA_ENDED':
      return status.alpha_status_reason
        ? t().membership.alphaEndedWithReason(status.alpha_status_reason)
        : t().membership.alphaEnded;
    default:
      return null;
  }
}

/** The stage disclaimer. Alpha rules may change; granted cycles are not wiped. */
export function alphaDisclaimer(): string {
  return t().membership.disclaimer;
}
