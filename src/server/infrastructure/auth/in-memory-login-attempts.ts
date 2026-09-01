import { Injectable } from '@nestjs/common';
import { InMemoryLoginAttempts as SharedInMemoryLoginAttempts } from '@joshuan/auth-adapters';
import { Clock } from '../../application/ports/clock';
import { LoginAttempts } from '../../application/ports/login-attempts';

export const FAILURES_BEFORE_BACKOFF = 5;

@Injectable()
export class InMemoryLoginAttempts extends LoginAttempts {
  private readonly shared: SharedInMemoryLoginAttempts;

  constructor(clock: Clock) {
    super();
    this.shared = new SharedInMemoryLoginAttempts(clock, {
      threshold: FAILURES_BEFORE_BACKOFF,
      baseDelayMs: 1_000,
      maxDelayMs: 15 * 60_000,
      maxEntries: 20_000,
    });
  }

  get tracked(): number {
    return this.shared.tracked;
  }

  retryAfterMs(email: string): number {
    return this.shared.retryAfterMs(email);
  }

  recordFailure(email: string): void {
    this.shared.recordFailure(email);
  }

  clear(email: string): void {
    this.shared.clear(email);
  }
}
