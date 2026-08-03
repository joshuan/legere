import { Module, type OnModuleInit } from '@nestjs/common';
import { HandleDocumentProcess } from '../../application/jobs/handle-document-process';
import { HandleFileIngest } from '../../application/jobs/handle-file-ingest';
import { HandleLibraryScan } from '../../application/jobs/handle-library-scan';
import { HandleMaintenance } from '../../application/jobs/handle-maintenance';
import { HandleScanSetMerge } from '../../application/jobs/handle-scanset-merge';
import type { ProcessingSettings } from '../../application/jobs/processing-settings';
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
import { CategoryRepository } from '../../domain/repositories/category.repository';
import { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { ScanSetRepository } from '../../domain/repositories/scan-set.repository';
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
        documents: DocumentRepository,
        libraries: LibraryRepository,
        reader: LibraryReader,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): HandleFileIngest =>
        new HandleFileIngest(fileRefs, documents, libraries, reader, mime, queue, unitOfWork),
      inject: [
        FileRefRepository,
        DocumentRepository,
        LibraryRepository,
        LibraryReader,
        MimeDetector,
        JobQueue,
        UnitOfWork,
      ],
    },
    {
      provide: HandleDocumentProcess,
      useFactory: (
        documents: DocumentRepository,
        fileRefs: FileRefRepository,
        libraries: LibraryRepository,
        reader: LibraryReader,
        files: FileStorage,
        pdfs: PdfToolbox,
        parser: DocumentParser,
        images: ImageTool,
        categories: CategoryRepository,
        classifier: DocumentAnalyst,
        chunks: DocumentChunkRepository,
        embeddings: EmbeddingProvider,
        unitOfWork: UnitOfWork,
        config: AppConfig,
      ): HandleDocumentProcess =>
        new HandleDocumentProcess(
          documents,
          fileRefs,
          libraries,
          reader,
          files,
          pdfs,
          parser,
          images,
          categories,
          classifier,
          chunks,
          embeddings,
          unitOfWork,
          processingSettings(config),
        ),
      inject: [
        DocumentRepository,
        FileRefRepository,
        LibraryRepository,
        LibraryReader,
        FileStorage,
        PdfToolbox,
        DocumentParser,
        ImageTool,
        CategoryRepository,
        DocumentAnalyst,
        DocumentChunkRepository,
        EmbeddingProvider,
        UnitOfWork,
        AppConfig,
      ],
    },
    {
      provide: HandleScanSetMerge,
      useFactory: (
        scanSets: ScanSetRepository,
        documents: DocumentRepository,
        fileRefs: FileRefRepository,
        libraries: LibraryRepository,
        reader: LibraryReader,
        files: FileStorage,
        images: ImageTool,
        pdfs: PdfToolbox,
        parser: DocumentParser,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): HandleScanSetMerge =>
        new HandleScanSetMerge(
          scanSets,
          documents,
          fileRefs,
          libraries,
          reader,
          files,
          images,
          pdfs,
          queue,
          unitOfWork,
        ),
      inject: [
        ScanSetRepository,
        DocumentRepository,
        FileRefRepository,
        LibraryRepository,
        LibraryReader,
        FileStorage,
        ImageTool,
        PdfToolbox,
        DocumentParser,
        JobQueue,
        UnitOfWork,
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
  exports: [
    HandleLibraryScan,
    HandleFileIngest,
    HandleDocumentProcess,
    HandleScanSetMerge,
    HandleMaintenance,
  ],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly workers: WorkerRegistry) {}

  onModuleInit(): void {
    this.workers.register(
      // One scan at a time per library, enforced by the queue's stately policy (docs/05 §5.2).
      { queue: 'library-scan', handler: HandleLibraryScan, concurrency: 1 },
      // Concurrency from QUEUE_CONCURRENCY_INGEST (docs/12 §12.4).
      { queue: 'file-ingest', handler: HandleFileIngest },
      // Concurrency from QUEUE_CONCURRENCY_PROCESS: these jobs hold whole files in memory and lean
      // on the Stirling container, so they are deliberately the least parallel of the three.
      { queue: 'document-process', handler: HandleDocumentProcess },
      // One merge per scan set at a time, enforced by the queue's stately policy (docs/06 §6.8).
      { queue: 'scanset-merge', handler: HandleScanSetMerge, concurrency: 1 },
      // Hourly housekeeping (docs/06 §6.8): expired credentials out, bucket usage measured.
      { queue: 'maintenance', handler: HandleMaintenance, concurrency: 1 },
    );
  }
}
