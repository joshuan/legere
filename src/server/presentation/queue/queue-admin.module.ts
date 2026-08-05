import { AnalysisSettings } from '../../application/settings/analysis-settings';
import { SettingsRepository } from '../../domain/repositories/settings.repository';
import { Module } from '@nestjs/common';
import { MetricsCache } from '../../application/ports/metrics-cache';
import { QueueMonitor } from '../../application/ports/queue-monitor';
import {
  GetQueueOverview,
  ListQueueFailures,
  RetryFailedJob,
} from '../../application/queue/inspect-queue';
import { DocumentRepository } from '../../domain/repositories/document.repository';
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
  ],
})
export class QueueAdminModule {}
