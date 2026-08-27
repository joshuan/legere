import { beforeEach, describe, expect, it } from 'vitest';
import { SlidingWindowThrottlerStorage } from './sliding-window-throttler-storage';

const TTL = 60_000;
const LIMIT = 3;

// The per-caller counters behind docs/08 §8.4, and the two things §8.4.1b promises about them: one
// client's burst is not everybody's, and the map does not grow for ever.
describe('SlidingWindowThrottlerStorage', () => {
  let at = 1_000_000;
  let storage: SlidingWindowThrottlerStorage;

  const hit = (key: string) => storage.increment(key, TTL, LIMIT, TTL, 'auth');

  beforeEach(() => {
    at = 1_000_000;
    storage = new SlidingWindowThrottlerStorage({ now: () => at });
  });

  it('admits the budget and refuses the request past it', async () => {
    for (let request = 1; request <= LIMIT; request += 1) {
      expect((await hit('alice')).isBlocked).toBe(false);
    }

    const refused = await hit('alice');
    expect(refused.isBlocked).toBe(true);
    expect(refused.timeToBlockExpire).toBe(60);
  });

  it('slides: a hit that has fallen out of the window is not counted', async () => {
    await hit('alice');
    await hit('alice');
    at += TTL + 1;

    const later = await hit('alice');
    expect(later.totalHits).toBe(1);
    expect(later.isBlocked).toBe(false);
  });

  it('lets a blocked caller back in once the block has passed', async () => {
    for (let request = 1; request <= LIMIT + 1; request += 1) await hit('alice');
    at += TTL + 1;

    expect((await hit('alice')).isBlocked).toBe(false);
  });

  // 🔒 SEC-73: the package's own storage files its decay timers under the throttler *name*, and
  // cancels the whole bucket whenever any blocked key comes back — so one anonymous caller cycling
  // "spend the budget, wait a minute, knock once" ratcheted every other client's counter upward
  // until an ordinary user met a 429 on their twenty-first sign-in ever.
  it('leaves every other caller alone when one of them is blocked and comes back', async () => {
    // Bob spends most of his budget…
    await hit('bob');
    await hit('bob');
    // …while Alice spends hers and gets blocked.
    for (let request = 1; request <= LIMIT + 1; request += 1) await hit('alice');

    // A minute later Alice knocks again, which is what fires the reset.
    at += TTL + 1;
    await hit('alice');

    // Bob's two hits are older than the window now, so his counter has decayed, not ratcheted.
    const bob = await hit('bob');
    expect(bob.totalHits).toBe(1);
    expect(bob.isBlocked).toBe(false);
  });

  it('counts two named budgets separately even under one key', async () => {
    for (let request = 1; request <= LIMIT + 1; request += 1) await hit('alice');

    const otherBudget = await storage.increment('alice', TTL, LIMIT, TTL, 'search');
    expect(otherBudget.isBlocked).toBe(false);
  });

  // 🔒 SEC-70's sibling: a key per source address, kept for the life of the process, is a leak.
  it('forgets a key whose window and block have both passed', async () => {
    await hit('alice');
    expect(storage.size).toBe(1);

    at += TTL * 2;
    await hit('bob');

    expect(storage.size).toBe(1);
  });

  it('never holds more keys than its ceiling, however wide the burst', async () => {
    const bounded = new SlidingWindowThrottlerStorage({ maxKeys: 10, now: () => at });

    for (let caller = 0; caller < 500; caller += 1) {
      await bounded.increment(`caller-${caller}`, TTL, LIMIT, TTL, 'auth');
    }

    expect(bounded.size).toBeLessThanOrEqual(10);
  });
});
