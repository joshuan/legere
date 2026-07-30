import { Module, type OnModuleInit } from '@nestjs/common';
import { HandleFileIngest } from '../../application/jobs/handle-file-ingest';
import { HandleLibraryScan } from '../../application/jobs/handle-library-scan';
import { Clock } from '../../application/ports/clock';
import { JobQueue } from '../../application/ports/job-queue';
import { LibraryReader } from '../../application/ports/library-reader';
import { MimeDetector } from '../../application/ports/mime-detector';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { WorkerRegistry } from '../../infrastructure/queue/worker-registry';

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
      ): HandleLibraryScan =>
        new HandleLibraryScan(libraries, fileRefs, scanRuns, reader, queue, clock),
      inject: [
        LibraryRepository,
        FileRefRepository,
        ScanRunRepository,
        LibraryReader,
        JobQueue,
        Clock,
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
  ],
  exports: [HandleLibraryScan, HandleFileIngest],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly workers: WorkerRegistry) {}

  onModuleInit(): void {
    this.workers.register(
      // One scan at a time per library, enforced by the queue's stately policy (docs/05 §5.2).
      { queue: 'library-scan', handler: HandleLibraryScan, concurrency: 1 },
      // Concurrency from QUEUE_CONCURRENCY_INGEST (docs/12 §12.4).
      { queue: 'file-ingest', handler: HandleFileIngest },
    );
  }
}
