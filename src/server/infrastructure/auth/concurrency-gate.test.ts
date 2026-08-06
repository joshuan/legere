import { describe, expect, it } from 'vitest';
import { ConcurrencyGate } from './concurrency-gate';

// A piece of work that never finishes until it is told to, so a test can hold slots open and look
// at how many are held.
function pending(): { promise: Promise<void>; finish: () => void } {
  let finish = (): void => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe('ConcurrencyGate', () => {
  it('runs work up to the limit at once', async () => {
    const gate = new ConcurrencyGate(2);
    const first = pending();
    const second = pending();
    let started = 0;

    void gate.run(async () => {
      started += 1;
      await first.promise;
    });
    void gate.run(async () => {
      started += 1;
      await second.promise;
    });
    await Promise.resolve();

    expect(started).toBe(2);

    first.finish();
    second.finish();
  });

  it('makes the work past the limit wait for a slot', async () => {
    const gate = new ConcurrencyGate(2);
    const held = [pending(), pending()];
    let started = 0;

    const running = held.map((slot) =>
      gate.run(async () => {
        started += 1;
        await slot.promise;
      }),
    );
    const queued = gate.run(async () => {
      started += 1;
    });
    await Promise.resolve();

    expect(started).toBe(2);

    held[0]?.finish();
    await queued;

    expect(started).toBe(3);

    held[1]?.finish();
    await Promise.all(running);
  });

  // The bug this guards against: releasing a slot and then taking it again lets a caller arriving
  // in between slip past the limit — once for every waiter, so a burst defeats the bound entirely.
  it('never exceeds the limit, however the work arrives', async () => {
    const gate = new ConcurrencyGate(3);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        gate.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, index % 5));
          active -= 1;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it('frees the slot when the work throws', async () => {
    const gate = new ConcurrencyGate(1);

    await expect(
      gate.run(() => Promise.reject(new Error('the work failed'))),
    ).rejects.toThrowError('the work failed');

    await expect(gate.run(() => Promise.resolve('the next one still runs'))).resolves.toBe(
      'the next one still runs',
    );
  });
});
