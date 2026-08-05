import { Global, Module } from '@nestjs/common';
import { JobQueue } from '../../application/ports/job-queue';
import { QueueMonitor } from '../../application/ports/queue-monitor';
import { QueueSettings, type QueueDefaults } from '../../application/queue/queue-settings';
import { SettingsRepository } from '../../domain/repositories/settings.repository';
import { AppConfig } from '../config/app-config';
import { PgBossJobQueue } from './pg-boss-job-queue';
import { PgBossQueueMonitor } from './pg-boss-queue-monitor';
import { PgBossProvider } from './pg-boss.provider';
import { WorkerRegistry } from './worker-registry';

// What a queue does when nobody has stored anything: the env values of docs/12 §12.4. A stored
// setting is somebody overriding one deliberately, so the defaults stay where they always were.
function queueDefaults(config: AppConfig): QueueDefaults {
  return {
    concurrency: {
      'library-scan': 1,
      'file-ingest': config.get('QUEUE_CONCURRENCY_INGEST'),
      'document-process': config.get('QUEUE_CONCURRENCY_PROCESS'),
      maintenance: 1,
    },
    unitConcurrency: config.get('QUEUE_UNIT_CONCURRENCY'),
  };
}

// Queue wiring (docs/06 §6.5, §6.8). Global so any feature module can enqueue and register workers.
@Global()
@Module({
  providers: [
    PgBossProvider,
    WorkerRegistry,
    {
      provide: QueueSettings,
      useFactory: (settings: SettingsRepository, config: AppConfig): QueueSettings =>
        new QueueSettings(settings, queueDefaults(config)),
      inject: [SettingsRepository, AppConfig],
    },
    { provide: JobQueue, useClass: PgBossJobQueue },
    { provide: QueueMonitor, useClass: PgBossQueueMonitor },
  ],
  exports: [PgBossProvider, WorkerRegistry, JobQueue, QueueMonitor, QueueSettings],
})
export class QueueModule {}
