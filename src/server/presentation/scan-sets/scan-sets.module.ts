import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { JobQueue } from '../../application/ports/job-queue';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import {
  CreateScanSet,
  DeleteScanSet,
  GetScanSet,
  ListScanSets,
  MergeScanSet,
  UpdateScanSet,
} from '../../application/scan-sets/manage-scan-sets';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { ScanSetRepository } from '../../domain/repositories/scan-set.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { ScanSetsController } from './scan-sets.controller';

// Scan sets (docs/06 §6.5).
@Module({
  controllers: [ScanSetsController],
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
      provide: ListScanSets,
      useFactory: (scanSets: ScanSetRepository): ListScanSets => new ListScanSets(scanSets),
      inject: [ScanSetRepository],
    },
    {
      provide: CreateScanSet,
      useFactory: (
        scanSets: ScanSetRepository,
        documents: DocumentRepository,
        unitOfWork: UnitOfWork,
      ): CreateScanSet => new CreateScanSet(scanSets, documents, unitOfWork),
      inject: [ScanSetRepository, DocumentRepository, UnitOfWork],
    },
    {
      provide: GetScanSet,
      useFactory: (scanSets: ScanSetRepository): GetScanSet => new GetScanSet(scanSets),
      inject: [ScanSetRepository],
    },
    {
      provide: UpdateScanSet,
      useFactory: (
        scanSets: ScanSetRepository,
        documents: DocumentRepository,
        unitOfWork: UnitOfWork,
      ): UpdateScanSet => new UpdateScanSet(scanSets, documents, unitOfWork),
      inject: [ScanSetRepository, DocumentRepository, UnitOfWork],
    },
    {
      provide: MergeScanSet,
      useFactory: (
        scanSets: ScanSetRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): MergeScanSet => new MergeScanSet(scanSets, queue, unitOfWork),
      inject: [ScanSetRepository, JobQueue, UnitOfWork],
    },
    {
      provide: DeleteScanSet,
      useFactory: (scanSets: ScanSetRepository, clock: Clock): DeleteScanSet =>
        new DeleteScanSet(scanSets, clock),
      inject: [ScanSetRepository, Clock],
    },
  ],
})
export class ScanSetsModule {}
