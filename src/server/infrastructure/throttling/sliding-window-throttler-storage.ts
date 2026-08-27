import type { ThrottlerStorage } from '@nestjs/throttler';

// The record shape the guard reads, taken from the port rather than from the package's internals:
// `ThrottlerStorageRecord` is declared inside @nestjs/throttler but not exported from its entry.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

// The per-IP / per-caller counters of docs/08 §8.4, kept the way that section says they are kept.
//
// 🔒 This exists instead of the package's own `ThrottlerStorageService` for two reasons, both
// recorded in docs/08 §8.4.1b. That implementation schedules one `setTimeout` per hit to decay it,
// files every timer under the *throttler name* rather than the key it belongs to, and cancels the
// whole bucket whenever any blocked key comes back — so one anonymous caller cycling "spend the
// budget, wait a minute, knock once" stopped the documented sliding window from sliding for every
// other client on the instance (SEC-73). And it never deletes a key, so the map grew one entry per
// source address for the life of the process.
//
// The window here is the timestamps of the hits still inside it. That makes it slide exactly, needs
// no timers at all — so there is nothing one key can cancel on another's behalf — and lets a key be
// dropped once both its window and its block have elapsed.

type Window = {
  // Ordered oldest-first; the hits still inside the window, and nothing else.
  hits: number[];
  // When the newest hit falls out, i.e. when this window is worth forgetting.
  expiresAt: number;
  // 0 when this caller is not blocked.
  blockedUntil: number;
};

// Sweeping on every request would make an ordinary call cost one pass over every key. The entries
// are seconds old and the sweep is only housekeeping, so it runs at most this often.
const SWEEP_INTERVAL_MS = 10_000;

// The backstop under the sweep: a burst wide enough to outrun one sweep interval still cannot grow
// the map without limit. Eviction takes the coldest key, which is the one least likely to be a
// caller mid-window.
const DEFAULT_MAX_KEYS = 50_000;

export type SlidingWindowThrottlerStorageOptions = {
  maxKeys?: number;
  // Injected in tests, which need to move time without waiting for it.
  now?: () => number;
};

export class SlidingWindowThrottlerStorage implements ThrottlerStorage {
  private readonly windows = new Map<string, Window>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(options: SlidingWindowThrottlerStorageOptions = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.now = options.now ?? (() => Date.now());
  }

  // What a test holds against the bound; the guard never asks.
  get size(): number {
    return this.windows.size;
  }

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = this.now();
    this.sweepExpired(now);

    // The generated key already carries the throttler's name, but the interface passes it
    // separately and a storage that ignored it would merge two budgets the day it stopped.
    const window = this.touch(`${throttlerName}:${key}`, now);
    this.evictOverflow();

    // A blocked caller pays nothing further into their own window: the block is the answer, and
    // counting the refusals would make the window restart itself.
    if (window.blockedUntil > now) return Promise.resolve(recordOf(window, now, ttl));

    window.blockedUntil = 0;
    const cutoff = now - ttl;
    window.hits = window.hits.filter((at) => at > cutoff);
    window.hits.push(now);
    window.expiresAt = now + ttl;
    // Over the limit, not at it: a budget of 20 admits twenty requests and refuses the twenty-first,
    // which is what the package's own storage does and what docs/08 §8.4 promises.
    if (window.hits.length > limit) window.blockedUntil = now + blockDuration;

    return Promise.resolve(recordOf(window, now, ttl));
  }

  private touch(id: string, now: number): Window {
    const existing = this.windows.get(id);
    const window = existing ?? { hits: [], expiresAt: now, blockedUntil: 0 };
    // Re-inserting moves the key to the end, so the map's own order is recency and the overflow
    // eviction below can take the coldest without keeping a second structure.
    this.windows.delete(id);
    this.windows.set(id, window);
    return window;
  }

  private sweepExpired(now: number): void {
    if (now - this.sweptAt < SWEEP_INTERVAL_MS) return;
    this.sweptAt = now;
    for (const [id, window] of this.windows) {
      if (window.expiresAt <= now && window.blockedUntil <= now) this.windows.delete(id);
    }
  }

  // Checked on every request, not on the sweep's schedule: a burst wide enough to outrun one sweep
  // interval is exactly the case this ceiling exists for.
  private evictOverflow(): void {
    while (this.windows.size > this.maxKeys) {
      const coldest = this.windows.keys().next();
      if (coldest.done === true) return;
      this.windows.delete(coldest.value);
    }
  }
}

// `timeToExpire` and `timeToBlockExpire` are seconds — that is what the guard writes into
// `X-RateLimit-Reset` and `Retry-After` — while `ttl` and `blockDuration` arrive in milliseconds.
function recordOf(window: Window, now: number, ttl: number): ThrottlerStorageRecord {
  const oldest = window.hits[0] ?? now;
  return {
    totalHits: window.hits.length,
    timeToExpire: seconds(oldest + ttl - now),
    isBlocked: window.blockedUntil > now,
    timeToBlockExpire: seconds(window.blockedUntil - now),
  };
}

function seconds(ms: number): number {
  return Math.ceil(Math.max(ms, 0) / 1000);
}
