import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createSubjectRequestSchema,
  listSubjectsQuerySchema,
  mergeSubjectsRequestSchema,
  subjectMergePreviewRequestSchema,
  updateSubjectRequestSchema,
  type CreateSubjectRequest,
  type ListSubjectsQuery,
  type MergeSubjectsRequest,
  type ListSubjectsResponse,
  type SubjectDto,
  type SubjectMergePreviewRequest,
  type SubjectMergePreviewResponse,
  type SubjectMergeSuggestionsResponse,
  type UpdateSubjectRequest,
} from '../../../shared/contracts/subjects';
import {
  catalogueSuggestionsQuerySchema,
  type CatalogueSuggestionsQuery,
  type Envelope,
} from '../../../shared/contracts/common';
import type { OkResponse } from '../../../shared/contracts/users';
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
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';

// Reading the catalogue and adding to it are open to anyone signed in: the analyst adds names on its
// own, and whoever corrects it must be able to add the one it missed without waiting for an admin
// (docs/03 §3.3.19).
@Controller('subjects')
@UseGuards(SessionGuard)
export class SubjectsController {
  constructor(
    private readonly list: ListSubjects,
    private readonly createSubject: CreateSubject,
  ) {}

  @Get()
  async listSubjects(
    @ZodQuery(listSubjectsQuerySchema) query: ListSubjectsQuery,
  ): Promise<Envelope<ListSubjectsResponse>> {
    return successEnvelope(await this.list.execute(query));
  }

  // 🔒 Rate-limited (SEC-56), like the people beside it.
  @Post()
  @Throttled('catalogue')
  async create(
    @ZodBody(createSubjectRequestSchema) body: CreateSubjectRequest,
  ): Promise<Envelope<SubjectDto>> {
    return successEnvelope(await this.createSubject.execute(body));
  }
}

// Renaming and removing reach across every document that names the subject, so they are an admin's
// (docs/11 §11.13).
@Controller('admin/subjects')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminSubjectsController {
  constructor(
    private readonly updateSubject: UpdateSubject,
    private readonly deleteSubject: DeleteSubject,
    private readonly mergeSubjects: MergeSubjects,
    private readonly suggestMerges: SuggestSubjectMerges,
    private readonly previewMerge: PreviewSubjectMerge,
  ) {}

  // Declared before `:id`, or the router reads "merge" as a subject id.
  @Post('merge')
  async merge(
    @ZodBody(mergeSubjectsRequestSchema) body: MergeSubjectsRequest,
  ): Promise<Envelope<SubjectDto>> {
    return successEnvelope(await this.mergeSubjects.execute(body));
  }

  // The analyst's reading of the things catalogue (docs/05 §5.6c), kind-aware, with the
  // placeholder rows beside the groups. `?refresh=1` drops the cached reading and asks anew.
  @Get('merge-suggestions')
  async mergeSuggestions(
    @ZodQuery(catalogueSuggestionsQuerySchema) query: CatalogueSuggestionsQuery,
  ): Promise<Envelope<SubjectMergeSuggestionsResponse>> {
    return successEnvelope(await this.suggestMerges.execute({ refresh: query.refresh === true }));
  }

  // A POST for the ids in its body, but a question — nothing is created (docs/11 §11.12a).
  @Post('merge-preview')
  @HttpCode(HttpStatus.OK)
  async mergePreview(
    @ZodBody(subjectMergePreviewRequestSchema) body: SubjectMergePreviewRequest,
  ): Promise<Envelope<SubjectMergePreviewResponse>> {
    return successEnvelope(await this.previewMerge.execute(body));
  }

  @Patch(':id')
  async update(
    @UuidParam('id', 'SUBJECT_NOT_FOUND', 'Subject') id: string,
    @ZodBody(updateSubjectRequestSchema) body: UpdateSubjectRequest,
  ): Promise<Envelope<SubjectDto>> {
    return successEnvelope(await this.updateSubject.execute(id, body));
  }

  @Delete(':id')
  async remove(
    @UuidParam('id', 'SUBJECT_NOT_FOUND', 'Subject') id: string,
  ): Promise<Envelope<OkResponse>> {
    await this.deleteSubject.execute(id);
    return successEnvelope({ ok: true });
  }
}
