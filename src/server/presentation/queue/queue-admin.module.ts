import { AnalysisSettings } from '../../application/settings/analysis-settings';
import { SettingsRepository } from '../../domain/repositories/settings.repository';
import { Module } from '@nestjs/common';
import { JobQueue } from '../../application/ports/job-queue';
import { MetricsCache } from '../../application/ports/metrics-cache';
import { QueueMonitor } from '../../application/ports/queue-monitor';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import {
  GetQueueOverview,
  ListQueueFailures,
  RetryFailedJob,
} from '../../application/queue/inspect-queue';
import { ReprocessDocumentsByStep } from '../../application/queue/reprocess-by-step';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminQueueController } from './admin-queue.controller';

// Admin queue observability (docs/06 §6.5).
@Module({
  controllers: [AdminQueueController],
  providers: [
    // The analysis language lives with the queue knobs: same kind of setting, same screen
    // (docs/05 §5.5).
    {
      provide: AnalysisSettings,
      useFactory: (settings: SettingsRepository): AnalysisSettings =>
        new AnalysisSettings(settings),
      inject: [SettingsRepository],
    },
    ...sessionGuardProviders,
    {
      provide: GetQueueOverview,
      useFactory: (
        monitor: QueueMonitor,
        documents: DocumentRepository,
        metrics: MetricsCache,
      ): GetQueueOverview => new GetQueueOverview(monitor, documents, metrics),
      inject: [QueueMonitor, DocumentRepository, MetricsCache],
    },
    {
      provide: ListQueueFailures,
      useFactory: (monitor: QueueMonitor): ListQueueFailures => new ListQueueFailures(monitor),
      inject: [QueueMonitor],
    },
    {
      provide: RetryFailedJob,
      useFactory: (monitor: QueueMonitor): RetryFailedJob => new RetryFailedJob(monitor),
      inject: [QueueMonitor],
    },
    // Running a step again for everything in one status is the per-document reprocess applied in a
    // loop — so it is built from the same use case, and leaves the same trace (docs/11 §11.13).
    {
      provide: ReprocessDocumentsByStep,
      useFactory: (
        documents: DocumentRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        config: AppConfig,
      ): ReprocessDocumentsByStep =>
        new ReprocessDocumentsByStep(
          documents,
          new ReprocessDocument(documents, events, queue),
          config.get('QUEUE_REPROCESS_MAX'),
        ),
      inject: [DocumentRepository, DocumentEventRepository, JobQueue, AppConfig],
    },
  ],
})
export class QueueAdminModule {}
