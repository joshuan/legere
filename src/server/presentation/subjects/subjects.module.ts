import { Module } from '@nestjs/common';
import {
  CreateSubject,
  DeleteSubject,
  ListSubjects,
  UpdateSubject,
} from '../../application/subjects/manage-subjects';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { AdminSubjectsController, SubjectsController } from './subjects.controller';

// Subjects (docs/06 §6.5): the catalogue behind the field, and the little that manages it.
@Module({
  controllers: [SubjectsController, AdminSubjectsController],
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
      provide: ListSubjects,
      useFactory: (subjects: SubjectRepository): ListSubjects => new ListSubjects(subjects),
      inject: [SubjectRepository],
    },
    {
      provide: CreateSubject,
      useFactory: (subjects: SubjectRepository, kinds: SubjectKindRepository): CreateSubject =>
        new CreateSubject(subjects, kinds),
      inject: [SubjectRepository, SubjectKindRepository],
    },
    {
      provide: UpdateSubject,
      useFactory: (subjects: SubjectRepository, kinds: SubjectKindRepository): UpdateSubject =>
        new UpdateSubject(subjects, kinds),
      inject: [SubjectRepository, SubjectKindRepository],
    },
    {
      provide: DeleteSubject,
      useFactory: (subjects: SubjectRepository, clock: Clock): DeleteSubject =>
        new DeleteSubject(subjects, clock),
      inject: [SubjectRepository, Clock],
    },
  ],
})
export class SubjectsModule {}
