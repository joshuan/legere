import { Module, type OnModuleInit } from '@nestjs/common';
import { HandleDocumentProcess } from '../../application/jobs/handle-document-process';
import { HandleFileIngest } from '../../application/jobs/handle-file-ingest';
import { HandleLibraryScan } from '../../application/jobs/handle-library-scan';
import { HandleMaintenance } from '../../application/jobs/handle-maintenance';
import type { ProcessingSettings } from '../../application/jobs/processing-settings';
import { BuildCanonical } from '../../application/documents/build-canonical';
import { CallContext } from '../../application/ports/call-context';
import { AsyncLocalCallContext } from '../../infrastructure/logging/async-call-context';
import { Clock } from '../../application/ports/clock';
import { DocumentAnalyst } from '../../application/ports/document-analyst';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { DocumentParser } from '../../application/ports/document-parser';
import { FileStorage } from '../../application/ports/file-storage';
import { MetricsCache } from '../../application/ports/metrics-cache';
import { ImageTool } from '../../application/ports/image-tool';
import { JobQueue } from '../../application/ports/job-queue';
import { LibraryReader } from '../../application/ports/library-reader';
import { MimeDetector } from '../../application/ports/mime-detector';
import { PdfToolbox } from '../../application/ports/pdf-toolbox';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { QueueSettings } from '../../application/queue/queue-settings';
import { AnalysisSettings } from '../../application/settings/analysis-settings';
import { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { PersonRepository } from '../../domain/repositories/person.repository';
import { SettingsRepository } from '../../domain/repositories/settings.repository';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { FileRepository } from '../../domain/repositories/file.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { WorkerRegistry } from '../../infrastructure/queue/worker-registry';

function processingSettings(config: AppConfig): ProcessingSettings {
  return {
    previewMaxDim: config.get('PREVIEW_MAX_DIM'),
    thumbMaxDim: config.get('THUMB_MAX_DIM'),
    // OCR_LANGUAGES is written the way tesseract takes it on the command line ("rus+eng"); the port
    // takes them one by one (docs/12 §12.4).
    ocrLanguages: config
      .get('OCR_LANGUAGES')
      .split('+')
      .map((language) => language.trim())
      .filter((language) => language !== ''),
    pdfTextMinCharsPerPage: config.get('PDF_TEXT_MIN_CHARS_PER_PAGE'),
    chunkTargetChars: config.get('CHUNK_TARGET_CHARS'),
    chunkOverlapChars: config.get('CHUNK_OVERLAP_CHARS'),
  };
}

// Binds the job handlers and tells the worker registry which queue each one serves (docs/06 §6.8).
// Registration happens on module init; the workers themselves start in bootstrap step 5, after the
// whole container is ready.
@Module({
  providers: [
    // The correlation id a pipeline step is run under (docs/03 §3.3.18). Bound here because the
    // jobs are what open a call; an HTTP request already has an id of its own (docs/06 §6.7).
    { provide: CallContext, useClass: AsyncLocalCallContext },
    // What the analysis writes in (docs/05 §5.5); read per run, so a change needs no restart.
    {
      provide: AnalysisSettings,
      useFactory: (settings: SettingsRepository): AnalysisSettings =>
        new AnalysisSettings(settings),
      inject: [SettingsRepository],
    },
    {
      provide: HandleLibraryScan,
      useFactory: (
        libraries: LibraryRepository,
        fileRefs: FileRefRepository,
        scanRuns: ScanRunRepository,
        reader: LibraryReader,
        queue: JobQueue,
        clock: Clock,
        config: AppConfig,
      ): HandleLibraryScan =>
        new HandleLibraryScan(
          libraries,
          fileRefs,
          scanRuns,
          reader,
          queue,
          clock,
          config.get('SCAN_MAX_FILES'),
        ),
      inject: [
        LibraryRepository,
        FileRefRepository,
        ScanRunRepository,
        LibraryReader,
        JobQueue,
        Clock,
        AppConfig,
      ],
    },
    {
      provide: HandleFileIngest,
      useFactory: (
        fileRefs: FileRefRepository,
        files: FileRepository,
        documents: DocumentRepository,
        events: DocumentEventRepository,
        libraries: LibraryRepository,
        reader: LibraryReader,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): HandleFileIngest =>
        new HandleFileIngest(
          fileRefs,
          files,
          documents,
          events,
          libraries,
          reader,
          mime,
          queue,
          unitOfWork,
        ),
      inject: [
        FileRefRepository,
        FileRepository,
        DocumentRepository,
        DocumentEventRepository,
        LibraryRepository,
        LibraryReader,
        MimeDetector,
        JobQueue,
        UnitOfWork,
      ],
    },
    // Step 1 on its own: what a document is made of, assembled into the one artifact every other
    // step reads (docs/05 §5.5 step 1).
    {
      provide: BuildCanonical,
      useFactory: (
        files: FileRepository,
        fileRefs: FileRefRepository,
        libraries: LibraryRepository,
        reader: LibraryReader,
        storage: FileStorage,
        images: ImageTool,
        pdfs: PdfToolbox,
        queueSettings: QueueSettings,
        config: AppConfig,
      ): BuildCanonical =>
        new BuildCanonical(
          files,
          fileRefs,
          libraries,
          reader,
          storage,
          images,
          pdfs,
          queueSettings,
          processingSettings(config),
        ),
      inject: [
        FileRepository,
        FileRefRepository,
        LibraryRepository,
        LibraryReader,
        FileStorage,
        ImageTool,
        PdfToolbox,
        QueueSettings,
        AppConfig,
      ],
    },
    {
      provide: HandleDocumentProcess,
      useFactory: (
        documents: DocumentRepository,
        events: DocumentEventRepository,
        canonical: BuildCanonical,
        files: FileStorage,
        pdfs: PdfToolbox,
        parser: DocumentParser,
        images: ImageTool,
        documentTypes: DocumentTypeRepository,
        classifier: DocumentAnalyst,
        people: PersonRepository,
        subjects: SubjectRepository,
        subjectKinds: SubjectKindRepository,
        chunks: DocumentChunkRepository,
        embeddings: EmbeddingProvider,
        unitOfWork: UnitOfWork,
        calls: CallContext,
        analysisSettings: AnalysisSettings,
        config: AppConfig,
      ): HandleDocumentProcess =>
        new HandleDocumentProcess(
          documents,
          events,
          canonical,
          files,
          pdfs,
          parser,
          images,
          documentTypes,
          classifier,
          people,
          subjects,
          subjectKinds,
          chunks,
          embeddings,
          unitOfWork,
          calls,
          analysisSettings,
          processingSettings(config),
        ),
      inject: [
        DocumentRepository,
        DocumentEventRepository,
        BuildCanonical,
        FileStorage,
        PdfToolbox,
        DocumentParser,
        ImageTool,
        DocumentTypeRepository,
        DocumentAnalyst,
        PersonRepository,
        SubjectRepository,
        SubjectKindRepository,
        DocumentChunkRepository,
        EmbeddingProvider,
        UnitOfWork,
        CallContext,
        AnalysisSettings,
        AppConfig,
      ],
    },
    {
      provide: HandleMaintenance,
      useFactory: (
        verifications: EmailVerificationRepository,
        invites: UserInviteRepository,
        resets: PasswordResetRepository,
        documents: DocumentRepository,
        files: FileStorage,
        metrics: MetricsCache,
        clock: Clock,
      ): HandleMaintenance =>
        new HandleMaintenance(verifications, invites, resets, documents, files, metrics, clock),
      inject: [
        EmailVerificationRepository,
        UserInviteRepository,
        PasswordResetRepository,
        DocumentRepository,
        FileStorage,
        MetricsCache,
        Clock,
      ],
    },
  ],
  exports: [HandleLibraryScan, HandleFileIngest, HandleDocumentProcess, HandleMaintenance],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly workers: WorkerRegistry) {}

  onModuleInit(): void {
    this.workers.register(
      // One scan at a time per library, enforced by the queue's stately policy (docs/05 §5.2).
      { queue: 'library-scan', handler: HandleLibraryScan, concurrency: 1 },
      // Concurrency from QUEUE_CONCURRENCY_INGEST (docs/12 §12.4).
      { queue: 'file-ingest', handler: HandleFileIngest },
      // Concurrency from QUEUE_CONCURRENCY_PROCESS: these jobs hold whole documents in memory and
      // lean on the Stirling container, so they are deliberately the least parallel of the three.
      { queue: 'document-process', handler: HandleDocumentProcess },
      // Hourly housekeeping (docs/06 §6.8): expired credentials out, bucket usage measured.
      { queue: 'maintenance', handler: HandleMaintenance, concurrency: 1 },
    );
  }
}
