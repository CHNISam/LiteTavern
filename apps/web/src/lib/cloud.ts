import { ApiError, api, type CloudQuotaSnapshot } from './api';
import { t } from './i18n';

/**
 * LiteTavern Cloud client state.
 *
 * The client renders whatever the server says and nothing more: capacity, quota
 * sizes, the reason a request is blocked and the support link all arrive from
 * `/v1/cloud/status`. Nothing about entitlements is decided here — in particular
 * the client never infers "you may generate" from a quota number, it only reads
 * `platform_models_available` and `block_reason`.
 *
 * The last successful status is cached so that, when LiteTavern Cloud is
 * unreachable, the UI can say "cloud unavailable, showing the last known state"
 * instead of either lying about the service or claiming the user's data is gone.
 */

export type AccountState =
  | 'GUEST'
  | 'UNVERIFIED'
  | 'REGISTERED'
  | 'ALPHA'
  | 'WAITLIST'
  | 'SUSPENDED';

export type CloudBlockReason =
  | 'GUEST'
  | 'EMAIL_UNVERIFIED'
  | 'ALPHA_CAPACITY_FULL'
  | 'WAITLISTED'
  | 'ACCOUNT_SUSPENDED'
  | 'DAILY_QUOTA_EXHAUSTED'
  | 'PERIOD_QUOTA_EXHAUSTED'
  | 'CONCURRENT_GENERATION'
  | 'PROVIDER_UNAVAILABLE';

export interface CloudStatus {
  stage: 'ALPHA';
  account_state: AccountState;
  email_verified: boolean;
  platform_models_available: boolean;
  /** Null if and only if `platform_models_available` is true. */
  block_reason: CloudBlockReason | null;
  byok_available: boolean;
  alpha: {
    active_batch: number;
    cumulative_capacity: number;
    remaining_capacity: number;
    batch_no: number | null;
    activated_at: string | null;
    promotion_expires_at: string | null;
    /**
     * How large an Alpha allowance is, as program configuration. `quota` is null
     * until a seat is actually activated, so this is the only honest source for
     * "每个周期提供 N 次云端回复额度" on the not-yet-activated panel — and the
     * client is not allowed to hardcode the numbers to fill that gap.
     */
    period_quota: number;
    period_days: number;
    daily_limit: number;
  };
  waitlist: { on_waitlist: boolean; joined_at: string | null };
  /**
   * The Turnstile widget to render before requesting a sign-in code. Null when
   * the deployment configured none, which the sign-in dialog reports rather than
   * quietly skipping the challenge.
   */
  turnstile_site_key: string | null;
  /** Null until Alpha is activated: there is no allowance to describe yet. */
  quota: CloudQuotaSnapshot | null;
  support: { enabled: boolean; url: string; headline: string; body: string };
}

/**
 * How the platform model service looks to this client right now.
 *
 * `blocked` always carries the server's reason, so no two blocked states can
 * collapse into one another. `offline` is the one state the client owns: it
 * means the client could not reach LiteTavern Cloud at all, which is not a
 * decision the server made about this account.
 */
export interface CloudModelServiceState {
  availability: 'checking' | 'available' | 'blocked' | 'offline';
  blockReason: CloudBlockReason | null;
  selected: boolean;
}

export function resolveCloudModelServiceState(
  status: CloudStatus | null,
  options: {
    checking?: boolean;
    offline?: boolean;
    /** A generation just failed because the upstream provider was down. */
    runtimeUnavailable?: boolean;
    selected?: boolean;
  } = {}
): CloudModelServiceState {
  const selected = options.selected ?? false;
  if (options.checking) {
    return { availability: 'checking', blockReason: null, selected };
  }
  if (options.offline || !status) {
    return { availability: 'offline', blockReason: null, selected };
  }
  if (options.runtimeUnavailable) {
    return {
      availability: 'blocked',
      blockReason: 'PROVIDER_UNAVAILABLE',
      selected
    };
  }
  if (status.platform_models_available) {
    return { availability: 'available', blockReason: null, selected };
  }
  return {
    availability: 'blocked',
    blockReason: status.block_reason,
    selected
  };
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

/** True when this browser has a LiteTavern Cloud identity beyond a guest. */
export function isSignedIn(status: CloudStatus | null): boolean {
  return status ? status.account_state !== 'GUEST' : false;
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

/** The service name is a proper noun, but the copy around it is translated. */
export function cloudProviderName(): string {
  return t().cloud.providerName;
}

/**
 * The two allowance windows, described rather than reduced to a bare number.
 *
 * Every field comes from `/v1/cloud/status`; nothing is estimated, and there is
 * no fallback total to divide by when the server has not sent one.
 */
export interface QuotaDescription {
  /** The service providing the allowance, named. */
  provider: string;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  /** 0–1, for a meter. */
  dailyRatio: number;
  dayUtc: string;
  periodLimit: number;
  periodUsed: number;
  periodRemaining: number;
  periodRatio: number;
  periodEndsAt: string;
  /** What one unit buys, in the user's terms. */
  unitName: string;
}

export function describeQuotaWindows(
  status: CloudStatus | null
): QuotaDescription | null {
  const quota = status?.quota;
  if (!quota) return null;
  return {
    provider: cloudProviderName(),
    dailyLimit: quota.daily_limit,
    // `used` is authoritative; deriving it from limit - remaining would hide
    // anything the server has reserved but not yet spent.
    dailyUsed: quota.daily_used,
    dailyRemaining: quota.daily_remaining,
    dailyRatio: quota.daily_limit > 0 ? quota.daily_remaining / quota.daily_limit : 0,
    dayUtc: quota.day_utc,
    periodLimit: quota.period_limit,
    periodUsed: quota.period_used,
    periodRemaining: quota.period_remaining,
    periodRatio:
      quota.period_limit > 0 ? quota.period_remaining / quota.period_limit : 0,
    periodEndsAt: quota.period_ends_at,
    unitName: t().cloud.replyUnit
  };
}

/** One-line form for compact surfaces such as the composer's mode switch. */
export function quotaLabel(status: CloudStatus | null): string {
  const described = describeQuotaWindows(status);
  if (!described) return t().cloud.noQuota(cloudProviderName());
  return t().cloud.quotaLabel(
    described.provider,
    described.dailyRemaining,
    described.dailyLimit,
    described.periodRemaining,
    described.periodLimit
  );
}

export type CloudNoticeTone = 'info' | 'warning' | 'error';

export interface CloudNotice {
  tone: CloudNoticeTone;
  title: string;
  body: string;
  /** Present only when the server says the user's own API key is usable. */
  byokHint: string | null;
}

/** A UTC calendar day, rendered in the reader's locale. */
/**
 * `day_utc` is already a UTC calendar day, not an instant. Running it through a
 * local-time Date would show the previous day to anyone west of UTC — telling
 * them their allowance resets a day earlier than it does.
 */
function formatDay(value: string): string {
  return value;
}

function formatMoment(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/**
 * The single explanation of what LiteTavern Cloud is currently doing for this
 * account, keyed off the server's `block_reason`.
 *
 * Every reason has its own copy: none of them may fall through to a generic
 * "platform models unavailable", because each one asks the reader to do
 * something different (verify an email, wait for a batch, wait for a reset,
 * retry, or contact support).
 */
export function resolveCloudNotice(status: CloudStatus | null): CloudNotice | null {
  if (!status) return null;
  const copy = t().cloudNotice;
  const byok = status.byok_available;
  const stillWorks = byok ? copy.byokStillWorks : null;
  const whileWaiting = byok ? copy.byokWhileWaiting : null;

  switch (status.block_reason) {
    case 'GUEST':
      return {
        tone: 'info',
        title: copy.guest.title,
        body: copy.guest.body,
        byokHint: stillWorks
      };
    case 'EMAIL_UNVERIFIED':
      return {
        tone: 'warning',
        title: copy.emailUnverified.title,
        body: copy.emailUnverified.body,
        byokHint: stillWorks
      };
    case 'ALPHA_CAPACITY_FULL':
      return {
        tone: 'info',
        title: copy.capacityFull.title,
        body: copy.capacityFull.body,
        byokHint: whileWaiting
      };
    case 'WAITLISTED':
      return {
        tone: 'info',
        title: copy.waitlisted.title,
        body: copy.waitlisted.body,
        byokHint: whileWaiting
      };
    case 'ACCOUNT_SUSPENDED':
      return {
        tone: 'error',
        title: copy.suspended.title,
        body: copy.suspended.body,
        byokHint: stillWorks
      };
    case 'DAILY_QUOTA_EXHAUSTED':
      return {
        tone: 'warning',
        title: copy.dailyExhausted.title,
        body: status.quota
          ? copy.dailyExhausted.resetsAt(formatDay(status.quota.day_utc))
          : copy.dailyExhausted.body,
        byokHint: stillWorks
      };
    case 'PERIOD_QUOTA_EXHAUSTED':
      return {
        tone: 'warning',
        title: copy.periodExhausted.title,
        body: status.quota
          ? copy.periodExhausted.resetsAt(formatMoment(status.quota.period_ends_at))
          : copy.periodExhausted.body,
        byokHint: stillWorks
      };
    case 'CONCURRENT_GENERATION':
      return {
        tone: 'info',
        title: copy.concurrent.title,
        body: copy.concurrent.body,
        byokHint: stillWorks
      };
    case 'PROVIDER_UNAVAILABLE':
      return {
        tone: 'warning',
        title: copy.providerUnavailable.title,
        body: copy.providerUnavailable.body,
        byokHint: stillWorks
      };
    case null:
      break;
  }

  // Nothing is blocked. A registered account that has not taken a seat yet is
  // told the batch is open and how large the allowance is — with the figures the
  // server sent, and only the ones it sent.
  if (status.account_state === 'REGISTERED' && status.alpha.remaining_capacity > 0) {
    const seats = copy.seatsAvailable;
    const lines = [
      seats.remaining(
        status.alpha.remaining_capacity,
        status.alpha.cumulative_capacity
      ),
      '',
      seats.howToJoin,
      // The allowance size is program configuration, not this account's balance:
      // `quota` is still null here because no seat has been activated yet.
      seats.periodLimit(status.alpha.period_quota)
    ];
    return {
      tone: 'info',
      title: seats.title,
      body: lines.join('\n'),
      byokHint: null
    };
  }
  return null;
}

/** The stage disclaimer. Alpha rules may change; granted cycles are not wiped. */
export function alphaDisclaimer(): string {
  return t().cloudNotice.disclaimer;
}
