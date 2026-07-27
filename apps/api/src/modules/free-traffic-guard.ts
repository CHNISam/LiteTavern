import { AppError } from '../lib/errors.js';

export interface FreeTrafficGuardOptions {
  userRateLimitPerMinute: number;
  ipRateLimitPerMinute: number;
  globalRateLimitPerMinute: number;
  globalConcurrency: number;
  now?: () => number;
}

interface WindowCounter {
  window: number;
  count: number;
}

export class FreeTrafficGuard {
  private readonly userCounters = new Map<string, WindowCounter>();
  private readonly ipCounters = new Map<string, WindowCounter>();
  private globalCounter: WindowCounter = { window: -1, count: 0 };
  private active = 0;
  private readonly now: () => number;

  constructor(private readonly options: FreeTrafficGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  enter(userId: string, ip: string): () => void {
    const window = Math.floor(this.now() / 60_000);
    this.consume(this.userCounters, userId, window, this.options.userRateLimitPerMinute);
    this.consume(this.ipCounters, ip, window, this.options.ipRateLimitPerMinute);
    if (this.globalCounter.window !== window) {
      this.globalCounter = { window, count: 0 };
    }
    if (this.globalCounter.count >= this.options.globalRateLimitPerMinute) {
      throw this.rateLimitError();
    }
    if (this.active >= this.options.globalConcurrency) {
      throw new AppError(
        'FREE_SERVICE_UNAVAILABLE',
        '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。',
        503,
        true
      );
    }
    this.globalCounter.count += 1;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  private consume(
    counters: Map<string, WindowCounter>,
    key: string,
    window: number,
    limit: number
  ) {
    const current = counters.get(key);
    const next =
      current?.window === window ? current : { window, count: 0 };
    if (next.count >= limit) throw this.rateLimitError();
    next.count += 1;
    counters.set(key, next);
  }

  private rateLimitError() {
    return new AppError(
      'FREE_RATE_LIMITED',
      '请求过于频繁，请稍后再试。本次不会扣除免费次数。',
      429,
      true
    );
  }
}
