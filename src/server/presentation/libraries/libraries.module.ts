import { Module } from '@nestjs/common';
import {
  CreateLibrary,
  DeleteLibrary,
  GetLibraryAdmin,
  ListLibrariesAdmin,
  ListLibraryPathCandidates,
  ListVisibleLibraries,
  UpdateLibrary,
} from '../../application/libraries/manage-libraries';
import { BrowseLibrary } from '../../application/libraries/browse-library';
import { ListScanRuns, TriggerScan } from '../../application/libraries/manage-scans';
import { Clock } from '../../application/ports/clock';
import { JobQueue } from '../../application/ports/job-queue';
import { LibraryReader } from '../../application/ports/library-reader';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminLibrariesController } from './admin-libraries.controller';
import { LibrariesController } from './libraries.controller';

// Libraries and scans (docs/06 §6.5). Use cases are framework-free, so each is bound explicitly.
@Module({
  controllers: [AdminLibrariesController, LibrariesController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: CreateLibrary,
      useFactory: (
        libraries: LibraryRepository,
        reader: LibraryReader,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): CreateLibrary => new CreateLibrary(libraries, reader, queue, unitOfWork),
      inject: [LibraryRepository, LibraryReader, JobQueue, UnitOfWork],
    },
    {
      provide: UpdateLibrary,
      useFactory: (
        libraries: LibraryRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): UpdateLibrary => new UpdateLibrary(libraries, queue, unitOfWork),
      inject: [LibraryRepository, JobQueue, UnitOfWork],
    },
    {
      provide: DeleteLibrary,
      useFactory: (libraries: LibraryRepository, queue: JobQueue, clock: Clock): DeleteLibrary =>
        new DeleteLibrary(libraries, queue, clock),
      inject: [LibraryRepository, JobQueue, Clock],
    },
    {
      provide: ListLibrariesAdmin,
      useFactory: (libraries: LibraryRepository, scanRuns: ScanRunRepository): ListLibrariesAdmin =>
        new ListLibrariesAdmin(libraries, scanRuns),
      inject: [LibraryRepository, ScanRunRepository],
    },
    {
      provide: GetLibraryAdmin,
      useFactory: (libraries: LibraryRepository): GetLibraryAdmin => new GetLibraryAdmin(libraries),
      inject: [LibraryRepository],
    },
    {
      provide: BrowseLibrary,
      useFactory: (
        libraries: LibraryRepository,
        fileRefs: FileRefRepository,
        documents: DocumentRepository,
      ): BrowseLibrary => new BrowseLibrary(libraries, fileRefs, documents),
      inject: [LibraryRepository, FileRefRepository, DocumentRepository],
    },
    {
      provide: ListVisibleLibraries,
      useFactory: (libraries: LibraryRepository): ListVisibleLibraries =>
        new ListVisibleLibraries(libraries),
      inject: [LibraryRepository],
    },
    {
      provide: ListLibraryPathCandidates,
      useFactory: (reader: LibraryReader): ListLibraryPathCandidates =>
        new ListLibraryPathCandidates(reader),
      inject: [LibraryReader],
    },
    {
      provide: TriggerScan,
      useFactory: (
        libraries: LibraryRepository,
        scanRuns: ScanRunRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): TriggerScan => new TriggerScan(libraries, scanRuns, queue, unitOfWork),
      inject: [LibraryRepository, ScanRunRepository, JobQueue, UnitOfWork],
    },
    {
      provide: ListScanRuns,
      useFactory: (libraries: LibraryRepository, scanRuns: ScanRunRepository): ListScanRuns =>
        new ListScanRuns(libraries, scanRuns),
      inject: [LibraryRepository, ScanRunRepository],
    },
  ],
})
export class LibrariesModule {}
