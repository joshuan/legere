import { Injectable } from '@nestjs/common';
import { Clock } from '../../application/ports/clock';
import { LoginAttempts } from '../../application/ports/login-attempts';

// Backoff starts at the fifth consecutive failure and doubles per failure, capped at fifteen
// minutes (docs/08 §8.4). Nothing here can lock an account out: the window is consulted only after
// a wrong password, so the owner's own password still opens the door mid-streak.
//
// 🔒 In memory, so a restart clears every streak. That is a deliberate limitation rather than an
// oversight — see docs/08 §8.4 for what it costs and what fixing it would take.
export const FAILURES_BEFORE_BACKOFF = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15 * 60 * 1000;

// 🔒 What the streaks are allowed to cost (docs/08 §8.4.1b). The key is whatever address a caller
// typed — up to 254 characters of their choosing — and failures are recorded for addresses nobody
// owns on purpose (§8.4.1a), so an unswept map grew a few hundred megabytes a month from one source
// IP spending exactly the documented budget, and gave none of it back short of a restart (SEC-70).
//
// A streak means nothing once the fifteen-minute cap has elapsed since its last failure: past that
// `retryAfterMs` answers 0 whatever it holds. So entries older than that are dropped on the way in,
// and a ceiling on the number of streaks evicts the coldest as a backstop. Neither can refuse
// anybody — forgetting a failure only ever helps the caller.
const MAX_STREAKS = 20_000;
const SWEEP_INTERVAL_MS = 60_000;

type Streak = { failures: number; lastFailureAt: number };

@Injectable()
export class InMemoryLoginAttempts extends LoginAttempts {
  private readonly streaks = new Map<string, Streak>();
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: Clock) {
    super();
  }

  // What a test holds against the bound; nothing in the flow asks.
  get tracked(): number {
    return this.streaks.size;
  }

  retryAfterMs(email: string): number {
    const streak = this.streaks.get(email);
    if (streak === undefined || streak.failures < FAILURES_BEFORE_BACKOFF) return 0;

    const overshoot = streak.failures - FAILURES_BEFORE_BACKOFF;
    const delay = Math.min(BASE_DELAY_MS * 2 ** overshoot, MAX_DELAY_MS);
    const elapsed = this.clock.now().getTime() - streak.lastFailureAt;
    return elapsed >= delay ? 0 : delay - elapsed;
  }

  recordFailure(email: string): void {
    const now = this.clock.now().getTime();
    const streak = this.streaks.get(email);
    this.prune(now);
    // Deleting first re-inserts at the end, so the map's own order is recency and the eviction
    // below takes the coldest streak rather than an arbitrary one.
    this.streaks.delete(email);
    this.streaks.set(email, { failures: (streak?.failures ?? 0) + 1, lastFailureAt: now });
  }

  clear(email: string): void {
    this.streaks.delete(email);
  }

  private prune(now: number): void {
    // A pass over every streak on every failed login would make a flood pay for its own size; the
    // entries are minutes old and the sweep is housekeeping, so it runs at most this often. The
    // ceiling below is checked every time, because that is the part a burst can outrun.
    if (now - this.sweptAt >= SWEEP_INTERVAL_MS) {
      this.sweptAt = now;
      const cutoff = now - MAX_DELAY_MS;
      for (const [email, streak] of this.streaks) {
        if (streak.lastFailureAt <= cutoff) this.streaks.delete(email);
      }
    }

    while (this.streaks.size >= MAX_STREAKS) {
      const coldest = this.streaks.keys().next();
      if (coldest.done === true) return;
      this.streaks.delete(coldest.value);
    }
  }
}
