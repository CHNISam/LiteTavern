import { describe, expect, it } from 'vitest';

import {
  resolveCloudModelServiceState,
  resolveCloudNotice,
  type CloudBlockReason,
  type CloudStatus
} from './cloud';

/**
 * The panel copy is a product requirement, not a detail: every reason a request
 * is blocked asks the reader to do something different (verify an email, wait
 * for a batch, wait for a reset, retry, contact support). Collapsing any two of
 * them into one message is the failure this file exists to catch.
 */

function status(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
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
  'PROVIDER_UNAVAILABLE'
];

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

  it('does not present a stale cached status as live service state', () => {
    const cached = status({ platform_models_available: true });
    expect(resolveCloudModelServiceState(cached, { offline: true })).toMatchObject({
      availability: 'offline'
    });
  });
});
