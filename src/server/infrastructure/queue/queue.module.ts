import { Global, Module } from '@nestjs/common';
import { JobQueue } from '../../application/ports/job-queue';
import { QueueMonitor } from '../../application/ports/queue-monitor';
import { QueueSettings, type QueueDefaults } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
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
    // The gates of docs/05 §5.4b, zero by default: an instance that upgrades into this waits
    // nowhere until an operator decides something should.
    services: {
      stirling: {
        concurrency: config.get('SERVICE_CONCURRENCY_STIRLING'),
        cooldownSeconds: config.get('SERVICE_COOLDOWN_STIRLING'),
      },
      docling: {
        concurrency: config.get('SERVICE_CONCURRENCY_DOCLING'),
        cooldownSeconds: config.get('SERVICE_COOLDOWN_DOCLING'),
      },
      classifier: {
        concurrency: config.get('SERVICE_CONCURRENCY_CLASSIFIER'),
        cooldownSeconds: config.get('SERVICE_COOLDOWN_CLASSIFIER'),
      },
      transcriber: {
        concurrency: config.get('SERVICE_CONCURRENCY_TRANSCRIBER'),
        cooldownSeconds: config.get('SERVICE_COOLDOWN_TRANSCRIBER'),
      },
      embeddings: {
        concurrency: config.get('SERVICE_CONCURRENCY_EMBEDDINGS'),
        cooldownSeconds: config.get('SERVICE_COOLDOWN_EMBEDDINGS'),
      },
    },
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
    // One registry of gates for the whole process, which is the whole of this instance (ADR-002).
    // It lives here, in the global queue module, because both the PDF adapters and the AI ones hold
    // a gate and neither may reach into the other (docs/05 §5.4b). Ungated until the stored
    // settings configure it, which the worker registry does as it starts.
    { provide: ServiceGates, useFactory: (): ServiceGates => new ServiceGates() },
  ],
  exports: [PgBossProvider, WorkerRegistry, JobQueue, QueueMonitor, QueueSettings, ServiceGates],
})
export class QueueModule {}
