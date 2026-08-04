import { Module } from '@nestjs/common';
import {
  CreateSubjectKind,
  DeleteSubjectKind,
  ListSubjectKinds,
  UpdateSubjectKind,
} from '../../application/subject-kinds/manage-subject-kinds';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { AdminSubjectKindsController, SubjectKindsController } from './subject-kinds.controller';

// Subject kinds (docs/06 §6.5): what sort of thing a subject is, as a catalogue of its own.
@Module({
  controllers: [SubjectKindsController, AdminSubjectKindsController],
  providers: [
    // The guards and what they need are providers of the module that uses them, the way every other
    // feature module does it (docs/06 §6.5).
    SessionGuard,
    RolesGuard,
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
      provide: ListSubjectKinds,
      useFactory: (kinds: SubjectKindRepository): ListSubjectKinds => new ListSubjectKinds(kinds),
      inject: [SubjectKindRepository],
    },
    {
      provide: CreateSubjectKind,
      useFactory: (kinds: SubjectKindRepository): CreateSubjectKind => new CreateSubjectKind(kinds),
      inject: [SubjectKindRepository],
    },
    {
      provide: UpdateSubjectKind,
      useFactory: (kinds: SubjectKindRepository): UpdateSubjectKind => new UpdateSubjectKind(kinds),
      inject: [SubjectKindRepository],
    },
    {
      provide: DeleteSubjectKind,
      useFactory: (kinds: SubjectKindRepository, clock: Clock): DeleteSubjectKind =>
        new DeleteSubjectKind(kinds, clock),
      inject: [SubjectKindRepository, Clock],
    },
  ],
})
export class SubjectKindsModule {}
