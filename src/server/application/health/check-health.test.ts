import { describe, expect, it } from 'vitest';
import { Clock } from '../ports/clock';
import { CheckHealth } from './check-health';
import { DbHealthChecker, QueueHealthChecker } from './ports';

class FakeDb extends DbHealthChecker {
  constructor(private readonly ok: boolean) {
    super();
  }
  ping(): Promise<boolean> {
    return Promise.resolve(this.ok);
  }
}

class FakeQueue extends QueueHealthChecker {
  constructor(private readonly state: 'ok' | 'down') {
    super();
  }
  status(): Promise<'ok' | 'down'> {
    return Promise.resolve(this.state);
  }
}

class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// A database that counts how often it was actually asked, so a test can tell an answer that was
// computed from one that was remembered.
class CountingDb extends DbHealthChecker {
  calls = 0;
  ping(): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(true);
  }
}

const clock = (): FixedClock => new FixedClock(new Date('2026-08-06T12:00:00.000Z'));

describe('CheckHealth', () => {
  it('reports ok when every component is healthy', async () => {
    const result = await new CheckHealth(new FakeDb(true), new FakeQueue('ok'), clock()).execute();
    expect(result).toEqual({ status: 'ok', db: 'ok', queue: 'ok' });
  });

  it('reports error when the database is down', async () => {
    const result = await new CheckHealth(new FakeDb(false), new FakeQueue('ok'), clock()).execute();
    expect(result).toEqual({ status: 'error', db: 'down', queue: 'ok' });
  });

  it('reports error when the queue is down', async () => {
    const result = await new CheckHealth(
      new FakeDb(true),
      new FakeQueue('down'),
      clock(),
    ).execute();
    expect(result).toEqual({ status: 'error', db: 'ok', queue: 'down' });
  });

  // 🔒 The route is unauthenticated by design — it is the container's probe — so without this every
  // caller buys a round trip to the database and anybody may call it as fast as they like.
  describe('the cost of being asked', () => {
    it('answers a second caller from what it already knows', async () => {
      const db = new CountingDb();
      const check = new CheckHealth(db, new FakeQueue('ok'), clock());

      await check.execute();
      await check.execute();
      await check.execute();

      expect(db.calls).toBe(1);
    });

    it('asks again once the answer has aged', async () => {
      const db = new CountingDb();
      const time = clock();
      const check = new CheckHealth(db, new FakeQueue('ok'), time);

      await check.execute();
      time.advance(1_500);
      await check.execute();

      expect(db.calls).toBe(2);
    });

    it('costs one round trip for a burst that arrives together', async () => {
      const db = new CountingDb();
      const check = new CheckHealth(db, new FakeQueue('ok'), clock());

      const results = await Promise.all(Array.from({ length: 20 }, () => check.execute()));

      expect(db.calls).toBe(1);
      expect(results.every((result) => result.status === 'ok')).toBe(true);
    });
  });
});
