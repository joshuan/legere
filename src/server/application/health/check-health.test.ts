import { describe, expect, it } from 'vitest';
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

describe('CheckHealth', () => {
  it('reports ok when every component is healthy', async () => {
    const result = await new CheckHealth(new FakeDb(true), new FakeQueue('ok')).execute();
    expect(result).toEqual({ status: 'ok', db: 'ok', queue: 'ok' });
  });

  it('reports error when the database is down', async () => {
    const result = await new CheckHealth(new FakeDb(false), new FakeQueue('ok')).execute();
    expect(result).toEqual({ status: 'error', db: 'down', queue: 'ok' });
  });

  it('reports error when the queue is down', async () => {
    const result = await new CheckHealth(new FakeDb(true), new FakeQueue('down')).execute();
    expect(result).toEqual({ status: 'error', db: 'ok', queue: 'down' });
  });
});
