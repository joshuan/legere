import type { HealthData } from '../../../shared/contracts/common';
import type { DbHealthChecker, QueueHealthChecker } from './ports';

// CheckHealth use case (docs/06 §6.3.1, §6.10): db checked with SELECT 1, queue via a state read
// (stubbed 'ok' until M3.2). status is 'ok' only when every component is healthy. Framework-free:
// wired with a factory provider in the presentation module (docs/06 §6.1).
export class CheckHealth {
  constructor(
    private readonly db: DbHealthChecker,
    private readonly queue: QueueHealthChecker,
  ) {}

  async execute(): Promise<HealthData> {
    const [dbOk, queue] = await Promise.all([this.db.ping(), this.queue.status()]);
    const db = dbOk ? 'ok' : 'down';
    const status = db === 'ok' && queue === 'ok' ? 'ok' : 'error';
    return { status, db, queue };
  }
}
