import { Module } from '@nestjs/common';
import {
  CreateSubjectKind,
  DeleteSubjectKind,
  ListSubjectKinds,
  UpdateSubjectKind,
} from '../../application/subject-kinds/manage-subject-kinds';
import { MergeSubjectKinds } from '../../application/subject-kinds/merge-subject-kinds';
import {
  PreviewSubjectKindMerge,
  SuggestSubjectKindMerges,
} from '../../application/subject-kinds/suggest-subject-kind-merges';
import { CatalogueAnalyst } from '../../application/ports/catalogue-analyst';
import { Clock } from '../../application/ports/clock';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
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
      provide: MergeSubjectKinds,
      useFactory: (
        kinds: SubjectKindRepository,
        subjects: SubjectRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): MergeSubjectKinds => new MergeSubjectKinds(kinds, subjects, unitOfWork, clock),
      inject: [SubjectKindRepository, SubjectRepository, UnitOfWork, Clock],
    },
    // A singleton on purpose: its in-process cache is the one concession the suggester makes to
    // cost (docs/05 §5.6c).
    {
      provide: SuggestSubjectKindMerges,
      useFactory: (
        kinds: SubjectKindRepository,
        analyst: CatalogueAnalyst,
      ): SuggestSubjectKindMerges => new SuggestSubjectKindMerges(kinds, analyst),
      inject: [SubjectKindRepository, CatalogueAnalyst],
    },
    {
      provide: PreviewSubjectKindMerge,
      useFactory: (
        kinds: SubjectKindRepository,
        analyst: CatalogueAnalyst,
      ): PreviewSubjectKindMerge => new PreviewSubjectKindMerge(kinds, analyst),
      inject: [SubjectKindRepository, CatalogueAnalyst],
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
