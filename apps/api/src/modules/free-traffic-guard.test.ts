import { describe, expect, it } from 'vitest';
import { FreeTrafficGuard } from './free-traffic-guard.js';

describe('official free traffic protection', () => {
  it('enforces per-user, IP, and concurrency limits without leaking active slots', () => {
    const guard = new FreeTrafficGuard({
      userRateLimitPerMinute: 2,
      ipRateLimitPerMinute: 3,
      globalRateLimitPerMinute: 10,
      globalConcurrency: 1,
      now: () => 60_000
    });
    const release = guard.enter('user-1', '127.0.0.1');
    expect(() => guard.enter('user-2', '127.0.0.2')).toThrowError(
      expect.objectContaining({ code: 'FREE_SERVICE_UNAVAILABLE' })
    );
    release();
    const releaseAgain = guard.enter('user-1', '127.0.0.1');
    releaseAgain();
    expect(() => guard.enter('user-1', '127.0.0.1')).toThrowError(
      expect.objectContaining({ code: 'FREE_RATE_LIMITED' })
    );
  });
});
