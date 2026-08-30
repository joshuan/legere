import { describe, expect, it } from 'vitest';
import { transactionOptions } from './prisma-unit-of-work';

// The two numbers a bound turns into (docs/06 §6.3.4). Asserted here rather than only through a
// real transaction because the second one is derived: `maxWait` is not what the caller asked for,
// and a version of this that passed the timeout alone would look right and still fail under the
// very load the bound was raised for — the pool is busiest exactly when the work is slow.
describe('transactionOptions', () => {
  it('passes the caller its own bound as the transaction timeout', () => {
    expect(transactionOptions({ timeoutMs: 180_000 }).timeout).toBe(180_000);
  });

  it('raises the wait for a connection with the bound, never past half of it', () => {
    expect(transactionOptions({ timeoutMs: 180_000 }).maxWait).toBe(90_000);
    expect(transactionOptions({ timeoutMs: 30_000 }).maxWait).toBe(15_000);
  });

  it('never lowers the wait below the driver default a bound-less run already gets', () => {
    // A short bound is still a bound on the work; queueing for a connection is not the work, and
    // shortening that queue is not something a caller asking for a longer transaction asked for.
    expect(transactionOptions({ timeoutMs: 1_000 }).maxWait).toBe(2_000);
    expect(transactionOptions({ timeoutMs: 4_000 }).maxWait).toBe(2_000);
  });
});
