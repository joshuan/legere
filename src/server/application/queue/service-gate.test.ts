import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueSettingsDto } from '../../../shared/contracts/queue';
import { ServiceGates } from './service-gate';
import { FixedClock } from '../../../../test/helpers/fakes';

// The per-service gates of docs/05 §5.4b: how many units of one service's work may be in flight, and
// how long a finished unit's slot stays shut. Everything here is either microtask-deterministic or
// driven by fake timers — a test that sleeps for a cooldown is a test that waits ten minutes.

function gatesFor(services: QueueSettingsDto['services']): ServiceGates {
  const gates = new ServiceGates(new FixedClock());
  gates.configure(services);
  return gates;
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// Everything the microtask queue has to say, without letting a real timer fire.
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

// A unit of work that does nothing but say it ran.
function marks(started: string[], name: string): () => Promise<void> {
  return () => {
    started.push(name);
    return Promise.resolve();
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ServiceGates', () => {
  it('admits one caller at a time and lets the next in in the order it arrived', async () => {
    const gates = gatesFor({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
    const started: string[] = [];
    const holds: Record<string, Deferred> = { a: deferred(), b: deferred(), c: deferred() };

    const calls = ['a', 'b', 'c'].map((name) =>
      gates.run('stirling', async () => {
        started.push(name);
        await holds[name]?.promise;
      }),
    );

    await flush();
    expect(started).toEqual(['a']);

    // FIFO, so a queue at a gate does not become a lottery (docs/05 §5.4b).
    holds.a?.resolve();
    await flush();
    expect(started).toEqual(['a', 'b']);

    holds.b?.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    holds.c?.resolve();
    await Promise.all(calls);
  });

  it('holds the slot for the whole cooldown after a unit that worked', async () => {
    vi.useFakeTimers();
    const gates = gatesFor({ stirling: { concurrency: 1, cooldownSeconds: 30 } });
    const started: string[] = [];

    await gates.run('stirling', marks(started, 'first'));
    const second = gates.run('stirling', marks(started, 'second'));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(started).toEqual(['first']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(['first', 'second']);
    await second;
  });

  it('holds it just as long after a unit that failed', async () => {
    vi.useFakeTimers();
    const gates = gatesFor({ stirling: { concurrency: 1, cooldownSeconds: 30 } });
    const started: string[] = [];

    // 🔒 A container that has just fallen over is the last one to hurry (docs/05 §5.4b).
    await expect(
      gates.run('stirling', () => {
        started.push('first');
        return Promise.reject(new Error('Stirling fell over'));
      }),
    ).rejects.toThrow('Stirling fell over');

    const second = gates.run('stirling', marks(started, 'second'));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(started).toEqual(['first']);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(['first', 'second']);
    await second;
  });

  it('treats a concurrency of 0 as no gate at all, cooldown included', async () => {
    vi.useFakeTimers();
    // The defaults an instance upgrades into, plus a cooldown that has no slot to hold shut.
    const gates = gatesFor({ stirling: { concurrency: 0, cooldownSeconds: 600 } });
    const started: string[] = [];
    const hold = deferred();

    const calls = ['a', 'b', 'c'].map((name) =>
      gates.run('stirling', async () => {
        started.push(name);
        await hold.promise;
      }),
    );

    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    hold.resolve();
    await Promise.all(calls);
    // Nothing was counted, so nothing is being held shut: no cooldown timer was ever armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is ungated until something configures it', async () => {
    const gates = new ServiceGates(new FixedClock());
    const started: string[] = [];
    const hold = deferred();

    const calls = ['a', 'b'].map((name) =>
      gates.run('embeddings', async () => {
        started.push(name);
        await hold.promise;
      }),
    );

    await flush();
    expect(started).toEqual(['a', 'b']);
    hold.resolve();
    await Promise.all(calls);
  });

  it('lets a caller already queued at a gate see a widened concurrency, with no restart', async () => {
    const gates = gatesFor({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
    const started: string[] = [];
    const hold = deferred();

    const calls = ['a', 'b'].map((name) =>
      gates.run('stirling', async () => {
        started.push(name);
        await hold.promise;
      }),
    );
    await flush();
    expect(started).toEqual(['a']);

    // 🔒 The one standing at the gate is released by the new number, rather than by whoever
    // restarts the container next (docs/05 §5.4b).
    gates.configure({ stirling: { concurrency: 2, cooldownSeconds: 0 } });
    await flush();
    expect(started).toEqual(['a', 'b']);

    hold.resolve();
    await Promise.all(calls);
  });

  it('narrows as slots come free rather than interrupting the work in flight', async () => {
    const gates = gatesFor({ stirling: { concurrency: 2, cooldownSeconds: 0 } });
    const started: string[] = [];
    const holds: Record<string, Deferred> = { a: deferred(), b: deferred(), c: deferred() };

    const calls = ['a', 'b', 'c'].map((name) =>
      gates.run('stirling', async () => {
        started.push(name);
        await holds[name]?.promise;
      }),
    );
    await flush();
    expect(started).toEqual(['a', 'b']);

    gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
    await flush();
    // Both units in flight run to the end; the third waits for the gate to be down to one again.
    expect(started).toEqual(['a', 'b']);

    holds.a?.resolve();
    await flush();
    expect(started).toEqual(['a', 'b']);

    holds.b?.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    holds.c?.resolve();
    await Promise.all(calls);
  });

  it('gates each service on its own, so one busy container does not hold up another', async () => {
    const gates = gatesFor({
      stirling: { concurrency: 1, cooldownSeconds: 0 },
      embeddings: { concurrency: 1, cooldownSeconds: 0 },
    });
    const started: string[] = [];
    const hold = deferred();

    const stirling = gates.run('stirling', async () => {
      started.push('stirling');
      await hold.promise;
    });
    const embeddings = gates.run('embeddings', marks(started, 'embeddings'));

    await flush();
    expect(started).toEqual(['stirling', 'embeddings']);

    hold.resolve();
    await Promise.all([stirling, embeddings]);
  });

  it('leaves a service this version does not gate to run ungated', async () => {
    const gates = new ServiceGates(new FixedClock());
    // A name a later version stored, or a typo: it configures nothing and gates nothing.
    gates.configure({ ocr: { concurrency: 1, cooldownSeconds: 60 } });
    const started: string[] = [];
    const hold = deferred();

    const calls = ['a', 'b'].map((name) =>
      gates.run('stirling', async () => {
        started.push(name);
        await hold.promise;
      }),
    );

    await flush();
    expect(started).toEqual(['a', 'b']);
    hold.resolve();
    await Promise.all(calls);
  });

  // 🔒 The only honest witness to a working gate: a step waiting at one reads as RUNNING exactly like
  // a step doing the work, so these three numbers are what an operator has (docs/05 §5.4b).
  describe('what a gate says it is doing', () => {
    it('counts the one in flight, the ones waiting, and how long the front has waited', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
      const hold = deferred();

      const calls = ['a', 'b', 'c'].map(() => gates.run('stirling', () => hold.promise));
      await flush();
      clock.advance(4_000);

      const stirling = gates.snapshot().find((row) => row.service === 'stirling');
      expect(stirling).toEqual({
        service: 'stirling',
        inFlight: 1,
        waiting: 2,
        // The one at the front has stood there for the whole four seconds; the one behind it arrived
        // in the same millisecond, and it is the front that is reported.
        longestWaitMs: 4_000,
        gated: true,
      });

      hold.resolve();
      await Promise.all(calls);
      // Everything through, nothing left standing.
      expect(gates.snapshot().find((row) => row.service === 'stirling')).toEqual({
        service: 'stirling',
        inFlight: 0,
        waiting: 0,
        longestWaitMs: 0,
        gated: true,
      });
    });

    it('falls back as slots come free rather than only at the end', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
      const holds: Record<string, Deferred> = { a: deferred(), b: deferred() };

      const calls = ['a', 'b'].map((name) =>
        gates.run('stirling', () => holds[name]?.promise ?? Promise.resolve()),
      );
      await flush();
      expect(gates.snapshot().find((row) => row.service === 'stirling')).toMatchObject({
        inFlight: 1,
        waiting: 1,
      });

      holds.a?.resolve();
      await flush();
      expect(gates.snapshot().find((row) => row.service === 'stirling')).toMatchObject({
        inFlight: 1,
        waiting: 0,
      });

      holds.b?.resolve();
      await Promise.all(calls);
    });

    it('says an ungated service is ungated rather than reporting three zeroes', () => {
      const gates = new ServiceGates(new FixedClock());
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });

      const snapshot = gates.snapshot();
      // Every service, in the order they are named, so the panel draws one row each (docs/07 §7.3).
      expect(snapshot.map((row) => row.service)).toEqual([
        'stirling',
        'docling',
        'classifier',
        'transcriber',
        'embeddings',
      ]);
      expect(snapshot.find((row) => row.service === 'stirling')?.gated).toBe(true);
      // 🔒 Nothing is being metered there, which is not the same as nothing waiting: three zeroes
      // read as a throttle that is idle instead of one that is off.
      expect(snapshot.find((row) => row.service === 'docling')).toEqual({
        service: 'docling',
        inFlight: 0,
        waiting: 0,
        longestWaitMs: 0,
        gated: false,
      });
    });
  });
});
