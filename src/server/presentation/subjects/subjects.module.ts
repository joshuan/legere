import { Module } from '@nestjs/common';
import {
  CreateSubject,
  DeleteSubject,
  ListSubjects,
  MergeSubjects,
  UpdateSubject,
} from '../../application/subjects/manage-subjects';
import {
  PreviewSubjectMerge,
  SuggestSubjectMerges,
} from '../../application/subjects/suggest-subject-merges';
import { CatalogueAnalyst } from '../../application/ports/catalogue-analyst';
import { Clock } from '../../application/ports/clock';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
import { RolesGuard } from '../auth/roles.guard';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminSubjectsController, SubjectsController } from './subjects.controller';

// Subjects (docs/06 §6.5): the catalogue behind the field, and the little that manages it.
@Module({
  controllers: [SubjectsController, AdminSubjectsController],
  providers: [
    // The guards and what they need are providers of the module that uses them, the way every other
    // feature module does it (docs/06 §6.5).
    ...sessionGuardProviders,
    RolesGuard,
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
      provide: MergeSubjects,
      useFactory: (
        subjects: SubjectRepository,
        kinds: SubjectKindRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): MergeSubjects => new MergeSubjects(subjects, kinds, unitOfWork, clock),
      inject: [SubjectRepository, SubjectKindRepository, UnitOfWork, Clock],
    },
    // A singleton on purpose: its in-process cache is the one concession the suggester makes to
    // cost (docs/05 §5.6c).
    {
      provide: SuggestSubjectMerges,
      useFactory: (subjects: SubjectRepository, analyst: CatalogueAnalyst): SuggestSubjectMerges =>
        new SuggestSubjectMerges(subjects, analyst),
      inject: [SubjectRepository, CatalogueAnalyst],
    },
    {
      provide: PreviewSubjectMerge,
      useFactory: (subjects: SubjectRepository, analyst: CatalogueAnalyst): PreviewSubjectMerge =>
        new PreviewSubjectMerge(subjects, analyst),
      inject: [SubjectRepository, CatalogueAnalyst],
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
