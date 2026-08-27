import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import { FAILURES_BEFORE_BACKOFF, InMemoryLoginAttempts } from './in-memory-login-attempts';

// The per-address backoff of docs/08 §8.4.1a, and what §8.4.1b says it is allowed to cost.
describe('InMemoryLoginAttempts', () => {
  function build() {
    const clock = new FixedClock();
    return { clock, attempts: new InMemoryLoginAttempts(clock) };
  }

  it('opens a window from the fifth consecutive failure and doubles it', async () => {
    const { attempts } = build();

    for (let failure = 1; failure < FAILURES_BEFORE_BACKOFF; failure += 1) {
      attempts.recordFailure('user@legere.local');
      expect(attempts.retryAfterMs('user@legere.local')).toBe(0);
    }

    attempts.recordFailure('user@legere.local');
    expect(attempts.retryAfterMs('user@legere.local')).toBe(1_000);
    attempts.recordFailure('user@legere.local');
    expect(attempts.retryAfterMs('user@legere.local')).toBe(2_000);

    await Promise.resolve();
  });

  it('forgets a streak a correct password cleared', () => {
    const { attempts } = build();

    for (let failure = 0; failure <= FAILURES_BEFORE_BACKOFF; failure += 1) {
      attempts.recordFailure('user@legere.local');
    }
    attempts.clear('user@legere.local');

    expect(attempts.retryAfterMs('user@legere.local')).toBe(0);
    expect(attempts.tracked).toBe(0);
  });

  // 🔒 SEC-70. The key is whatever address a caller typed, and failures are recorded for addresses
  // nobody owns on purpose (§8.4.1a), so an unswept map grew for the life of the process from one
  // source IP spending exactly the documented budget.
  it('sweeps streaks nothing can still be waiting on', () => {
    const { clock, attempts } = build();

    for (let address = 0; address < 100; address += 1) {
      attempts.recordFailure(`${'a'.repeat(240)}${address}@e.com`);
    }
    expect(attempts.tracked).toBe(100);

    // Past the fifteen-minute cap, a streak can no longer delay anybody whatever it holds.
    clock.advance(15 * 60 * 1000 + 1);
    attempts.recordFailure('someone-new@legere.local');

    expect(attempts.tracked).toBe(1);
  });

  it('caps the number of streaks it will hold at once', () => {
    const { attempts } = build();

    for (let address = 0; address < 30_000; address += 1) {
      attempts.recordFailure(`victim-${address}@legere.local`);
    }

    expect(attempts.tracked).toBeLessThanOrEqual(20_000);
  });

  // Eviction is only ever a forgotten failure: it can slow nobody down and lock nobody out, which
  // is why a cap is safe here at all (§8.4.1a).
  it('evicts the coldest streak rather than the one being written', () => {
    const { attempts } = build();

    for (let failure = 0; failure <= FAILURES_BEFORE_BACKOFF; failure += 1) {
      attempts.recordFailure('recent@legere.local');
    }
    expect(attempts.retryAfterMs('recent@legere.local')).toBeGreaterThan(0);

    for (let address = 0; address < 25_000; address += 1) {
      attempts.recordFailure(`filler-${address}@legere.local`);
    }

    // The streak the flood pushed out is forgotten, not preserved at somebody else's expense.
    expect(attempts.retryAfterMs('recent@legere.local')).toBe(0);
    expect(attempts.tracked).toBeLessThanOrEqual(20_000);
  });
});
