import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import { Clock } from '../../application/ports/clock';
import { JobQueue } from '../../application/ports/job-queue';
import { SessionTokens } from '../../application/ports/session-tokens';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { DocumentsController } from './documents.controller';

// Documents (docs/06 §6.5). Reprocessing is the whole module for now; the read model lands in M5.
@Module({
  controllers: [DocumentsController],
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
      provide: ReprocessDocument,
      useFactory: (documents: DocumentRepository, queue: JobQueue): ReprocessDocument =>
        new ReprocessDocument(documents, queue),
      inject: [DocumentRepository, JobQueue],
    },
  ],
})
export class DocumentsModule {}
