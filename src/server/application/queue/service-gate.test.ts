import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueSettingsDto } from '../../../shared/contracts/queue';
import {
  MAX_RETRY_AFTER_MS,
  ServiceThrottledError,
  ServiceUnavailableError,
} from '../ports/service-unavailable';
import { safeRetryAfterResumeAt, ServiceGates } from './service-gate';
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
  describe('a provider Retry-After hold', () => {
    it('chooses the provider deadline inside an hour, then the later midpoint or last hour', () => {
      const now = new Date('2026-09-05T12:00:00.000Z');

      expect(safeRetryAfterResumeAt(new Date('2026-09-05T12:30:00.000Z'), now)).toEqual(
        new Date('2026-09-05T12:30:00.000Z'),
      );
      // Ninety minutes: the midpoint (45 min) is later than one hour before the deadline (30 min).
      expect(safeRetryAfterResumeAt(new Date('2026-09-05T13:30:00.000Z'), now)).toEqual(
        new Date('2026-09-05T12:45:00.000Z'),
      );
      // Three hours: one hour before the deadline is later than the midpoint.
      expect(safeRetryAfterResumeAt(new Date('2026-09-05T15:00:00.000Z'), now)).toEqual(
        new Date('2026-09-05T14:00:00.000Z'),
      );
    });

    it('stops the FIFO without dialing or rejecting each waiter, then resumes automatically', async () => {
      vi.useFakeTimers();
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ classifier: { concurrency: 1, cooldownSeconds: 0 } });
      const firstAnswer = deferred();
      const started: string[] = [];
      const first = gates.run('classifier', async () => {
        started.push('first');
        await firstAnswer.promise;
        throw new ServiceThrottledError('classifier', new Date(clock.now().getTime() + 60_000));
      });
      const second = gates.run('classifier', marks(started, 'second'));
      const third = gates.run('classifier', marks(started, 'third'));
      await flush();

      firstAnswer.resolve();
      await expect(first).rejects.toBeInstanceOf(ServiceThrottledError);
      await flush();
      // The response cost the unit that received it one retry. Everyone behind it remains pending:
      // no work was dialed, and no second error was manufactured for either waiter.
      expect(started).toEqual(['first']);
      expect(gates.snapshot().find((row) => row.service === 'classifier')).toMatchObject({
        waiting: 2,
        throttledUntil: '2026-01-01T12:01:00.000Z',
      });

      clock.advance(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all([second, third]);
      expect(started).toEqual(['first', 'second', 'third']);
      expect(gates.snapshot().find((row) => row.service === 'classifier')).toMatchObject({
        waiting: 0,
        throttledUntil: null,
      });
    });

    it('holds an operator-ungated service too', async () => {
      vi.useFakeTimers();
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ embeddings: { concurrency: 0, cooldownSeconds: 600 } });
      const started: string[] = [];

      await expect(
        gates.run('embeddings', () =>
          Promise.reject(
            new ServiceThrottledError('embeddings', new Date(clock.now().getTime() + 10_000)),
          ),
        ),
      ).rejects.toBeInstanceOf(ServiceThrottledError);
      const waiting = gates.run('embeddings', marks(started, 'after hold'));
      await flush();

      expect(started).toEqual([]);
      expect(gates.snapshot().find((row) => row.service === 'embeddings')).toMatchObject({
        gated: false,
        waiting: 1,
        throttledUntil: '2026-01-01T12:00:10.000Z',
      });

      clock.advance(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await waiting;
      expect(started).toEqual(['after hold']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('lets a later response extend the hold and never lets an earlier one shorten it', async () => {
      vi.useFakeTimers();
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ classifier: { concurrency: 3, cooldownSeconds: 0 } });
      const replies = [deferred(), deferred(), deferred()];
      const deadlines = [30, 180, 10].map(
        (minutes) => new Date(clock.now().getTime() + minutes * 60_000),
      );
      const calls = replies.map((reply, index) =>
        gates.run('classifier', async () => {
          await reply.promise;
          const deadline = deadlines[index];
          if (deadline === undefined) throw new Error('missing test deadline');
          throw new ServiceThrottledError('classifier', deadline);
        }),
      );
      await flush();

      replies[0]?.resolve();
      await expect(calls[0]).rejects.toBeInstanceOf(ServiceThrottledError);
      expect(gates.snapshot().find((row) => row.service === 'classifier')?.throttledUntil).toBe(
        '2026-01-01T12:30:00.000Z',
      );

      replies[1]?.resolve();
      await expect(calls[1]).rejects.toBeInstanceOf(ServiceThrottledError);
      // Three hours uses one hour before the provider deadline: two hours from now.
      expect(gates.snapshot().find((row) => row.service === 'classifier')?.throttledUntil).toBe(
        '2026-01-01T14:00:00.000Z',
      );

      replies[2]?.resolve();
      await expect(calls[2]).rejects.toBeInstanceOf(ServiceThrottledError);
      expect(gates.snapshot().find((row) => row.service === 'classifier')?.throttledUntil).toBe(
        '2026-01-01T14:00:00.000Z',
      );
    });

    it('turns an out-of-bound typed deadline back into the ordinary short breaker', async () => {
      vi.useFakeTimers();
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      const started: string[] = [];

      await expect(
        gates.run('classifier', () =>
          Promise.reject(
            new ServiceThrottledError(
              'classifier',
              new Date(clock.now().getTime() + MAX_RETRY_AFTER_MS + 1),
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(ServiceThrottledError);
      await expect(gates.run('classifier', marks(started, 'too early'))).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
      expect(started).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      clock.advance(30_000);
      await gates.run('classifier', marks(started, 'probe'));
      expect(started).toEqual(['probe']);
    });
  });

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

  // 🔒 The hold after a unit died of unavailability (docs/05 §5.4e): a queue of documents must not
  // walk into a dead container one five-minute timeout at a time.
  describe('the hold after the service was unreachable', () => {
    const died = (): Promise<never> =>
      Promise.reject(new ServiceUnavailableError('stirling', 'fetch failed'));

    it('refuses the units that follow, instantly, and admits again after the hold', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
      const started: string[] = [];

      await expect(gates.run('stirling', died)).rejects.toThrow('unreachable');
      // Fail fast, before waiting and before dialing: the refusal is the same typed error, so the
      // step runner treats it exactly like the failure that armed it.
      await expect(gates.run('stirling', marks(started, 'refused'))).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
      expect(started).toEqual([]);

      clock.advance(30_000);
      await gates.run('stirling', marks(started, 'probe'));
      expect(started).toEqual(['probe']);
    });

    it('works even on a gate of zeroes, which is not throttling healthy work', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      const started: string[] = [];

      await expect(
        gates.run('docling', () =>
          Promise.reject(new ServiceUnavailableError('docling', 'fetch failed')),
        ),
      ).rejects.toThrow('unreachable');
      await expect(gates.run('docling', marks(started, 'refused'))).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
      expect(started).toEqual([]);

      clock.advance(30_000);
      await gates.run('docling', marks(started, 'probe'));
      expect(started).toEqual(['probe']);
    });

    it('rearms when the probe dies too', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
      const started: string[] = [];

      await expect(gates.run('stirling', died)).rejects.toThrow('unreachable');
      clock.advance(30_000);
      // The first caller past the hold goes through and is the probe — and it dies here.
      await expect(gates.run('stirling', died)).rejects.toThrow('unreachable');
      await expect(gates.run('stirling', marks(started, 'refused'))).rejects.toBeInstanceOf(
        ServiceUnavailableError,
      );
      expect(started).toEqual([]);
    });

    it('refuses a unit that was already waiting when the one ahead of it died', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
      const started: string[] = [];
      const hold = deferred();

      const first = gates.run('stirling', async () => {
        await hold.promise;
        throw new ServiceUnavailableError('stirling', 'fetch failed');
      });
      const second = gates.run('stirling', marks(started, 'second'));
      await flush();

      hold.resolve();
      // 🔒 Checked again on the far side of the queue: the second unit was standing at the gate
      // before the first died, and it must not dial the dead container either.
      await expect(first).rejects.toThrow('unreachable');
      await expect(second).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(started).toEqual([]);
    });

    it('arms nothing on an ordinary failure', async () => {
      const clock = new FixedClock();
      const gates = new ServiceGates(clock);
      gates.configure({ stirling: { concurrency: 1, cooldownSeconds: 0 } });
      const started: string[] = [];

      // A 500 is the service answering — that document broke it (docs/05 §5.4e).
      await expect(
        gates.run('stirling', () => Promise.reject(new Error('Stirling choked on the file'))),
      ).rejects.toThrow('choked');
      await gates.run('stirling', marks(started, 'next'));
      expect(started).toEqual(['next']);
    });
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
        throttledUntil: null,
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
        throttledUntil: null,
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
        throttledUntil: null,
      });
    });
  });
});
