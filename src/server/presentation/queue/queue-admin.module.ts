import { AnalysisSettings } from '../../application/settings/analysis-settings';
import { SettingsRepository } from '../../domain/repositories/settings.repository';
import { Module } from '@nestjs/common';
import { CheckExternalServices } from '../../application/health/check-external-services';
import { ExternalServiceProbe } from '../../application/health/ports';
import { Clock } from '../../application/ports/clock';
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
import { ServiceGates } from '../../application/queue/service-gate';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { HttpExternalServiceProbe } from '../../infrastructure/health/http-external-service-probe';
import { QueueSettings } from '../../application/queue/queue-settings';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminQueueController } from './admin-queue.controller';
import { PipelineController } from './pipeline.controller';

// Admin queue observability (docs/06 §6.5), and the one route beside it that is not an admin's: which
// steps the pipeline is holding, which every reader of a document is owed (docs/05 §5.4d).
@Module({
  controllers: [AdminQueueController, PipelineController],
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
    // Whether the five services of docs/05 §5.4b are there at all. The probe is wired here rather
    // than beside the clients it asks about, because what counts as a cheap question is one table
    // read in one place (docs/05 §5.4c).
    { provide: ExternalServiceProbe, useClass: HttpExternalServiceProbe },
    {
      provide: CheckExternalServices,
      useFactory: (probe: ExternalServiceProbe, clock: Clock): CheckExternalServices =>
        new CheckExternalServices(probe, clock),
      inject: [ExternalServiceProbe, Clock],
    },
    {
      provide: GetQueueOverview,
      useFactory: (
        monitor: QueueMonitor,
        documents: DocumentRepository,
        chunks: DocumentChunkRepository,
        metrics: MetricsCache,
        gates: ServiceGates,
      ): GetQueueOverview => new GetQueueOverview(monitor, documents, chunks, metrics, gates),
      inject: [
        QueueMonitor,
        DocumentRepository,
        DocumentChunkRepository,
        MetricsCache,
        ServiceGates,
      ],
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
        queueSettings: QueueSettings,
        config: AppConfig,
      ): ReprocessDocumentsByStep =>
        new ReprocessDocumentsByStep(
          documents,
          new ReprocessDocument(documents, events, queue, queueSettings),
          queueSettings,
          config.get('QUEUE_REPROCESS_MAX'),
        ),
      inject: [DocumentRepository, DocumentEventRepository, JobQueue, QueueSettings, AppConfig],
    },
  ],
})
export class QueueAdminModule {}
