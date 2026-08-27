import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../domain/errors/domain-error';
import { WholeFileReads } from './whole-file-reads';

// 🔒 The bound the request path was missing (docs/05 §5.4a, docs/09 §9.1): each of the three upload
// bodies and the page-thumb render is capped in how much it may hold and none of them was capped in
// how many may hold it at once, so twenty-five ordinary requests reached 2.5 GB in a container given
// 2 GB — the container that is also Nest, Next and the queue workers.

describe('WholeFileReads', () => {
  // A promise nobody resolves until the test says so.
  function held(): { work: () => Promise<void>; finish: () => void } {
    let finish = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { work: () => promise, finish: () => finish() };
  }

  it('runs up to the limit at once and makes the rest wait', async () => {
    const gate = new WholeFileReads(2, 8);
    const first = held();
    const second = held();
    let thirdStarted = false;

    const running = [gate.run(first.work), gate.run(second.work)];
    const third = gate.run(async () => {
      thirdStarted = true;
      return Promise.resolve();
    });
    await Promise.resolve();

    expect(thirdStarted).toBe(false);

    first.finish();
    second.finish();
    await Promise.all([...running, third]);
    expect(thirdStarted).toBe(true);
  });

  it('gives the slot back even when the work throws', async () => {
    const gate = new WholeFileReads(1, 8);

    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  // 🔒 A wait list that only grows is a second way to spend the process's memory, and a caller held
  // for minutes has already been failed — they are just not being told (docs/05 §5.4a).
  it('refuses rather than queueing for ever once the wait list is full', async () => {
    const gate = new WholeFileReads(1, 2);
    const busy = held();

    const inFlight = gate.run(busy.work);
    const waiting = [gate.run(() => Promise.resolve()), gate.run(() => Promise.resolve())];

    await expect(gate.run(() => Promise.resolve())).rejects.toBeInstanceOf(RateLimitedError);

    busy.finish();
    await Promise.all([inFlight, ...waiting]);
  });

  // Nobody may overtake a queue that has already formed — the rule the service gates follow, so a
  // steady stream of arrivals cannot starve the caller who got there first.
  it('serves the waiting in the order they arrived', async () => {
    const gate = new WholeFileReads(1, 8);
    const busy = held();
    const order: number[] = [];

    const inFlight = gate.run(busy.work);
    const queued = [1, 2, 3].map((n) =>
      gate.run(() => {
        order.push(n);
        return Promise.resolve();
      }),
    );

    busy.finish();
    await Promise.all([inFlight, ...queued]);
    expect(order).toEqual([1, 2, 3]);
  });
});
