import { Global, Module } from '@nestjs/common';
import { JobQueue } from '../../application/ports/job-queue';
import { QueueMonitor } from '../../application/ports/queue-monitor';
import { PgBossJobQueue } from './pg-boss-job-queue';
import { PgBossQueueMonitor } from './pg-boss-queue-monitor';
import { PgBossProvider } from './pg-boss.provider';
import { WorkerRegistry } from './worker-registry';

// Queue wiring (docs/06 §6.5, §6.8). Global so any feature module can enqueue and register workers.
@Global()
@Module({
  providers: [
    PgBossProvider,
    WorkerRegistry,
    { provide: JobQueue, useClass: PgBossJobQueue },
    { provide: QueueMonitor, useClass: PgBossQueueMonitor },
  ],
  exports: [PgBossProvider, WorkerRegistry, JobQueue, QueueMonitor],
})
export class QueueModule {}
