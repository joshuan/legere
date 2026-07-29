import { Injectable } from '@nestjs/common';
import { QueueHealthChecker } from '../../application/health/ports';
import { QueueMonitor } from '../../application/ports/queue-monitor';

// Real queue state, replacing the stub of M0.4 (docs/06 §6.10): the queue is healthy once pg-boss
// has started and its schema is readable.
@Injectable()
export class PgBossQueueHealthChecker extends QueueHealthChecker {
  constructor(private readonly monitor: QueueMonitor) {
    super();
  }

  async status(): Promise<'ok' | 'down'> {
    return (await this.monitor.isHealthy()) ? 'ok' : 'down';
  }
}
