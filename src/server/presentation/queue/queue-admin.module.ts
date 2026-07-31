import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { QueueMonitor } from '../../application/ports/queue-monitor';
import { SessionTokens } from '../../application/ports/session-tokens';
import {
  GetQueueOverview,
  ListQueueFailures,
  RetryFailedJob,
} from '../../application/queue/inspect-queue';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { AdminQueueController } from './admin-queue.controller';

// Admin queue observability (docs/06 §6.5).
@Module({
  controllers: [AdminQueueController],
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
      provide: GetQueueOverview,
      useFactory: (monitor: QueueMonitor, documents: DocumentRepository): GetQueueOverview =>
        new GetQueueOverview(monitor, documents),
      inject: [QueueMonitor, DocumentRepository],
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
