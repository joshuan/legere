// A bound on how many pieces of work run at once, with the rest queued in arrival order.
//
// It exists for password hashing (docs/08 §8.4). Argon2 runs on the libuv threadpool — four threads
// by default, shared with every filesystem and DNS call the process makes — and login verifies a
// hash even for an address nobody registered, deliberately, so that a wrong address and a wrong
// password cost the same (docs/08 §8.1.4). Without a bound, a flood of logins holds every thread
// and the server stops doing anything else: not by running out of memory or CPU, but by running
// out of threads, which looks like a hang rather than a crash and so never restarts itself.
//
// Callers wait rather than being refused: a queue is slow under load, and refusing would make the
// bound visible to an attacker and turn a slow login into a failed one for everybody else.
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    } else {
      this.active += 1;
    }

    try {
      return await work();
    } finally {
      this.release();
    }
  }

  // A finished slot is handed to the next waiter rather than given back and taken again: releasing
  // first would let a caller arriving in between slip past the limit, once per waiter.
  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    next();
  }
}
