import { Injectable } from '@nestjs/common';
import { Clock } from '../../application/ports/clock';
import { LoginAttempts } from '../../application/ports/login-attempts';

// Backoff starts after five consecutive failures and doubles per failure, capped so an account is
// never locked out permanently (docs/08 §8.4).
export const FAILURES_BEFORE_BACKOFF = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15 * 60 * 1000;

type Streak = { failures: number; lastFailureAt: number };

@Injectable()
export class InMemoryLoginAttempts extends LoginAttempts {
  private readonly streaks = new Map<string, Streak>();

  constructor(private readonly clock: Clock) {
    super();
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
    const streak = this.streaks.get(email);
    this.streaks.set(email, {
      failures: (streak?.failures ?? 0) + 1,
      lastFailureAt: this.clock.now().getTime(),
    });
  }

  clear(email: string): void {
    this.streaks.delete(email);
  }
}
