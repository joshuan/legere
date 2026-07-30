import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import {
  CreateLibrary,
  DeleteLibrary,
  GetLibraryAdmin,
  ListLibrariesAdmin,
  ListLibraryPathCandidates,
  ListVisibleLibraries,
  UpdateLibrary,
} from '../../application/libraries/manage-libraries';
import { ListScanRuns, TriggerScan } from '../../application/libraries/manage-scans';
import { Clock } from '../../application/ports/clock';
import { JobQueue } from '../../application/ports/job-queue';
import { LibraryReader } from '../../application/ports/library-reader';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { AdminLibrariesController } from './admin-libraries.controller';
import { LibrariesController } from './libraries.controller';

// Libraries and scans (docs/06 §6.5). Use cases are framework-free, so each is bound explicitly.
@Module({
  controllers: [AdminLibrariesController, LibrariesController],
  providers: [
    SessionGuard,
    {
      provide: AuthenticateSession,
      useFactory: (
        sessions: SessionRepository,
        users: UserRepository,
        tokens: SessionTokens,
        clock: Clock,
      ): AuthenticateSession => new AuthenticateSession(sessions, users, tokens, clock),
      inject: [SessionRepository, UserRepository, SessionTokens, Clock],
    },
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
