import type { HealthData } from '../../../shared/contracts/common';
import type { Clock } from '../ports/clock';
import type { DbHealthChecker, QueueHealthChecker } from './ports';

// How long an answer stands. The route is unauthenticated by design — it is the container's probe —
// so without this every caller buys a `SELECT 1` and a queue state read, and anyone may call it as
// fast as they like. A second is far below the probe interval, so an operator never reads a stale
// component, and far above what a flood would need to be expensive (docs/06 §6.10).
const FRESH_FOR_MS = 1_000;

// CheckHealth use case (docs/06 §6.3.1, §6.10): db checked with SELECT 1, queue via a state read.
// status is 'ok' only when every component is healthy. Framework-free: wired with a factory
// provider in the presentation module (docs/06 §6.1).
export class CheckHealth {
  private answered: { at: number; data: HealthData } | null = null;
  // The check in flight, if there is one: a burst arriving together should cost one round trip, not
  // one each, and they all want the same answer anyway.
  private inFlight: Promise<HealthData> | null = null;

  constructor(
    private readonly db: DbHealthChecker,
    private readonly queue: QueueHealthChecker,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<HealthData> {
    const now = this.clock.now().getTime();
    const answered = this.answered;
    if (answered !== null && now - answered.at < FRESH_FOR_MS) return answered.data;

    this.inFlight ??= this.check().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async check(): Promise<HealthData> {
    const [dbOk, queue] = await Promise.all([this.db.ping(), this.queue.status()]);
    const db = dbOk ? 'ok' : 'down';
    const status = db === 'ok' && queue === 'ok' ? 'ok' : 'error';
    const data: HealthData = { status, db, queue };
    this.answered = { at: this.clock.now().getTime(), data };
    return data;
  }
}
