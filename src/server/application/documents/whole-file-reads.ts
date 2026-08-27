import { RateLimitedError } from '../../domain/errors/domain-error';

// 🔒 How many request handlers may hold a whole file in memory at once (docs/05 §5.4a, docs/09 §9.1).
//
// Three routes read a file whole while somebody waits on the socket: the two upload bodies and the
// replacement body (`readUploadBody`, up to `UPLOAD_MAX_BYTES`), and the page thumb, which on a cache
// miss opens the file the page belongs to (up to `MAX_BINARY_BYTES`). Each is bounded per call and
// none was bounded in how many such calls may be in flight, so twenty-five concurrent requests for
// twenty-five different pages of one 100 MiB scan is 2.5 GB resident in a container given 2 GB
// (docs/12 §12.7) — and that container is Nest, Next and the queue workers together (ADR-002). This
// is the unfixed half of the first audit's SEC-20, which named the missing per-read cap (fixed) and
// the missing concurrency cap (not).
//
// The queue has had this shape since §5.4b: a fixed number of units in flight, everybody else in
// FIFO order so that the caller who arrived first is not starved by the ones behind them.

// Four, from the memory the container is given. Four uploads at the shipped 100 MiB cap is 400 MiB;
// four page thumbs of files at the 256 MiB ceiling is 1 GiB, which is the worst case this admits and
// the reason it is not eight — the pipeline is running in the same process and holds up to 256 MiB
// per document-process worker of its own.
const DEFAULT_LIMIT = 4;

// 🔒 And the queue is bounded too, which the Argon2 gate beside it is not: a wait list that only
// grows is a second way to spend the process's memory, one closure per request, and a caller held
// for minutes has already been failed — they are just not being told. Past this depth the answer is
// `429`, which a client can read and retry.
const DEFAULT_MAX_WAITING = 32;

export class WholeFileReads {
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limit: number = DEFAULT_LIMIT,
    private readonly maxWaiting: number = DEFAULT_MAX_WAITING,
  ) {}

  // Runs `work` with a slot held, and gives the slot to whoever is next whatever the outcome.
  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    // Nobody may overtake a queue that has already formed — the rule the service gates follow, so
    // that a steady stream of new requests cannot leave an earlier one waiting for ever.
    if (this.waiting.length === 0 && this.inFlight < this.limit) {
      this.inFlight += 1;
      return;
    }
    if (this.waiting.length >= this.maxWaiting) {
      throw new RateLimitedError(
        'RATE_LIMITED',
        'This instance is already reading as many files as it can hold at once',
      );
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    this.waiting.shift()?.();
  }
}

// 🔒 One gate for the whole process, because the memory is the whole process's. Not a Nest provider:
// the upload bodies are read in an Express-level helper that runs before any controller is resolved,
// and a bound only half the callers pass through is not a bound.
export const wholeFileReads = new WholeFileReads();
