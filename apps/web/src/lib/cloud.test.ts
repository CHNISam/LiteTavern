import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isCompatibleCloudStatus,
  readCachedStatus,
  reportSyncCheckpoint,
  resolveCloudModelServiceState,
  resolveCloudNotice,
  type CloudBlockReason,
  type CloudStatus
} from './cloud';
import { en } from './i18n/en';

/**
 * The panel copy is a product requirement, not a detail: every reason a request
 * is blocked asks the reader to do something different (verify an email, wait
 * for a batch, wait for a reset, retry, contact support). Collapsing any two of
 * them into one message is the failure this file exists to catch.
 */

function status(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
    contract_version: 2,
    capabilities: {
      auth: true,
      asset_sync: true,
      platform_generation: true,
      client_turn_sync: true,
      reply_suggestions: true
    },
    stage: 'ALPHA',
    account_state: 'REGISTERED',
    email_verified: true,
    platform_models_available: false,
    block_reason: null,
    byok_available: true,
    alpha: {
      active_batch: 1,
      cumulative_capacity: 10,
      remaining_capacity: 3,
      batch_no: null,
      activated_at: null,
      promotion_expires_at: null,
      period_quota: 1500,
      period_days: 30,
      daily_limit: 200
    },
    waitlist: { on_waitlist: false, joined_at: null },
    turnstile_site_key: 'test-site-key',
    quota: null,
    support: { enabled: false, url: '', headline: '', body: '' },
    ...overrides
  };
}

const BLOCK_REASONS: CloudBlockReason[] = [
  'GUEST',
  'EMAIL_UNVERIFIED',
  'ALPHA_CAPACITY_FULL',
  'WAITLISTED',
  'ACCOUNT_SUSPENDED',
  'DAILY_QUOTA_EXHAUSTED',
  'PERIOD_QUOTA_EXHAUSTED',
  'CONCURRENT_GENERATION',
  'PROVIDER_UNAVAILABLE',
  'PLATFORM_MODELS_NOT_CONFIGURED',
  'CLOUD_CONTRACT_BLOCKED'
];

describe('cloud deployment contract', () => {
  it('requires version 2 and every browser capability', () => {
    const compatible = status();
    expect(isCompatibleCloudStatus(compatible)).toBe(true);
    expect(isCompatibleCloudStatus({ ...compatible, contract_version: 1 })).toBe(false);
    expect(isCompatibleCloudStatus({
      ...compatible,
      capabilities: { ...compatible.capabilities, client_turn_sync: false }
    })).toBe(false);
  });
});

describe('cached status', () => {
  afterEach(() => localStorage.clear());

  it('ignores an entry written by a build with an older contract', () => {
    // The cache outlives the build that wrote it. A reader who used LiteTavern before
    // the v2 contract has an object in storage with no `capabilities` at all, and this
    // used to hand it straight back under a bare `as CloudStatus`. `App` seeds its
    // state from this read, so the first `capabilities.legacy_http_migration` threw
    // during render: a blank page on every load, for everyone who had opened the app
    // before — and unrecoverable by reloading, because the reload re-read the cache.
    localStorage.setItem('litetavern.cloud.status.v1', JSON.stringify({
      stage: 'ALPHA',
      account_state: 'ALPHA',
      email_verified: true,
      platform_models_available: true,
      block_reason: null,
      byok_available: true
    }));

    expect(readCachedStatus()).toBeNull();
  });

  it('ignores an entry whose capabilities no longer satisfy this build', () => {
    // Same rule, one step subtler: the shape is current but a capability this build
    // requires is off. The network read answers to exactly this check, and a cache
    // entry is that same claim made earlier.
    const stale = status();
    localStorage.setItem('litetavern.cloud.status.v1', JSON.stringify({
      ...stale,
      capabilities: { ...stale.capabilities, client_turn_sync: false }
    }));

    expect(readCachedStatus()).toBeNull();
  });

  it('returns an entry that still speaks this contract', () => {
    // The cache has to keep working — it is what puts the last known state on screen
    // before the network answers.
    const current = status();
    localStorage.setItem('litetavern.cloud.status.v1', JSON.stringify(current));

    expect(readCachedStatus()).toEqual(current);
  });

  it('treats unreadable storage as no cache rather than throwing', () => {
    localStorage.setItem('litetavern.cloud.status.v1', 'not json');

    expect(readCachedStatus()).toBeNull();
  });
});

describe('sync checkpoint wire contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the client SYNCED state to the Worker SUCCESS state', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sync: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    await reportSyncCheckpoint({ status: 'SYNCED', pendingCount: 0 });

    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      device_key: string;
      status: string;
      pending_count: number;
    };
    expect(body.device_key).toBeTruthy();
    expect(body.status).toBe('SUCCESS');
    expect(body.pending_count).toBe(0);
  });
});

describe('cloud notice copy', () => {
  it('gives every block reason its own wording', () => {
    const rendered = BLOCK_REASONS.map((reason) => {
      const notice = resolveCloudNotice(status({ block_reason: reason }));
      expect(notice, reason).not.toBeNull();
      return `${notice?.title}\n${notice?.body}`;
    });

    expect(new Set(rendered).size).toBe(BLOCK_REASONS.length);
    // In particular, nothing may fall through to the provider-outage message.
    const providerCopy = rendered[BLOCK_REASONS.indexOf('PROVIDER_UNAVAILABLE')];
    expect(rendered.filter((text) => text === providerCopy)).toHaveLength(1);
  });

  it('never invites a retry when the deployment has no model service at all', () => {
    // The real incident this guards: a deployment with no provider credentials
    // told everyone "这是暂时的故障，稍后重试即可", so readers retried a state that
    // could not improve. The unconfigured copy must not do that again — and it
    // must not blame the reader's connection either.
    const notice = resolveCloudNotice(
      status({ block_reason: 'PLATFORM_MODELS_NOT_CONFIGURED' })
    );

    const text = `${notice?.title}\n${notice?.body}`;
    expect(text).not.toMatch(/重试|再试|稍后|retry|try again/i);
    expect(text).not.toMatch(/网络|断网|connection|offline/i);
    // The rollback promise holds on this path too, so the reassurance stays.
    expect(notice?.body).toContain('本次不会消耗额度');
    // There is somewhere to go instead of a dead retry button.
    expect(notice?.body).toContain('反馈');
  });

  it('does not reuse the transient outage copy for the unconfigured deployment', () => {
    const transient = resolveCloudNotice(
      status({ block_reason: 'PROVIDER_UNAVAILABLE' })
    );
    const unconfigured = resolveCloudNotice(
      status({ block_reason: 'PLATFORM_MODELS_NOT_CONFIGURED' })
    );

    expect(unconfigured?.title).not.toBe(transient?.title);
    expect(unconfigured?.body).not.toBe(transient?.body);
    // The transient wording is left exactly as it was: it is still correct for
    // an upstream that really did blip.
    expect(transient?.body).toBe('这是暂时的故障，稍后重试即可，本次不会消耗额度。');
  });

  it('keeps the English unconfigured copy free of retry wording too', () => {
    const copy = en.cloudNotice.platformNotConfigured;
    const text = `${copy.title}\n${copy.body}`;

    expect(text).not.toMatch(/retry|try again|later|refresh/i);
    expect(text).not.toMatch(/connection|network|offline/i);
    expect(copy.body).toContain('Nothing was deducted from your allowance');
    expect(copy.body).toContain('feedback');
    expect(copy.body).not.toBe(en.cloudNotice.providerUnavailable.body);
  });

  it('tells a registered account the seat count and what a seat is worth', () => {
    const notice = resolveCloudNotice(
      status({ platform_models_available: true, block_reason: null })
    );

    expect(notice?.title).toBe('第一批 Alpha 免费测试');
    expect(notice?.body).toContain('剩余名额：3 / 10');
    expect(notice?.body).toContain('注册并验证邮箱，首次使用云端模型时自动获得资格。');
    // `quota` is null until a seat is activated, so this line has to come from
    // the program configuration rather than from a balance the account lacks.
    expect(notice?.body).toContain('每个周期提供 1500 次云端回复额度。');
  });

  it('reports the UTC reset day exactly as the server sent it', () => {
    // Rendering a UTC calendar day through a local-time Date tells anyone west
    // of UTC their allowance resets a day early.
    const notice = resolveCloudNotice(
      status({
        account_state: 'ALPHA',
        block_reason: 'DAILY_QUOTA_EXHAUSTED',
        quota: {
          period_limit: 1500,
          period_used: 300,
          period_reserved: 0,
          period_remaining: 1200,
          period_started_at: '2026-08-01T00:00:00.000Z',
          period_ends_at: '2026-08-31T00:00:00.000Z',
          daily_limit: 200,
          daily_used: 200,
          daily_reserved: 0,
          daily_remaining: 0,
          day_utc: '2026-08-06'
        }
      })
    );

    expect(notice?.body).toContain('UTC 2026-08-06');
  });

  it('offers BYOK only when the server says the key is usable', () => {
    const waitlisted = resolveCloudNotice(status({ block_reason: 'WAITLISTED' }));
    expect(waitlisted?.byokHint).toBe('等待期间可以使用自己的 API Key。');

    const guest = resolveCloudNotice(
      status({ account_state: 'GUEST', block_reason: 'GUEST', byok_available: false })
    );
    expect(guest?.byokHint).toBeNull();
  });
});

describe('platform model availability', () => {
  it('keeps "we could not reach Cloud" distinct from "Cloud said no"', () => {
    expect(resolveCloudModelServiceState(null)).toMatchObject({
      availability: 'offline',
      blockReason: null
    });
    expect(
      resolveCloudModelServiceState(status({ block_reason: 'WAITLISTED' }))
    ).toMatchObject({ availability: 'blocked', blockReason: 'WAITLISTED' });
    expect(
      resolveCloudModelServiceState(status({ platform_models_available: true }))
    ).toMatchObject({ availability: 'available', blockReason: null });
  });

  it('reports the runtime refusal the server actually sent', () => {
    // A status that still claims the models are available must not overwrite the
    // reason the generation was just refused with — and a deployment that was
    // never configured must not be downgraded to a passing provider outage.
    const live = status({ platform_models_available: true });

    expect(
      resolveCloudModelServiceState(live, {
        runtimeBlockReason: 'PLATFORM_MODELS_NOT_CONFIGURED'
      })
    ).toMatchObject({
      availability: 'blocked',
      blockReason: 'PLATFORM_MODELS_NOT_CONFIGURED'
    });
    expect(
      resolveCloudModelServiceState(live, {
        runtimeBlockReason: 'PROVIDER_UNAVAILABLE'
      })
    ).toMatchObject({
      availability: 'blocked',
      blockReason: 'PROVIDER_UNAVAILABLE'
    });
  });

  it('does not present a stale cached status as live service state', () => {
    const cached = status({ platform_models_available: true });
    expect(resolveCloudModelServiceState(cached, { offline: true })).toMatchObject({
      availability: 'offline'
    });
  });
});
