import { Module } from '@nestjs/common';
import {
  CreateSubjectKind,
  DeleteSubjectKind,
  ListSubjectKinds,
  UpdateSubjectKind,
} from '../../application/subject-kinds/manage-subject-kinds';
import { Clock } from '../../application/ports/clock';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { RolesGuard } from '../auth/roles.guard';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminSubjectKindsController, SubjectKindsController } from './subject-kinds.controller';

// Subject kinds (docs/06 §6.5): what sort of thing a subject is, as a catalogue of its own.
@Module({
  controllers: [SubjectKindsController, AdminSubjectKindsController],
  providers: [
    // The guards and what they need are providers of the module that uses them, the way every other
    // feature module does it (docs/06 §6.5).
    ...sessionGuardProviders,
    RolesGuard,
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
