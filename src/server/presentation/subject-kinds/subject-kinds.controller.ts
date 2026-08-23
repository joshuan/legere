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
  createSubjectKindRequestSchema,
  mergeSubjectKindsRequestSchema,
  updateSubjectKindRequestSchema,
  type CreateSubjectKindRequest,
  type ListSubjectKindsResponse,
  subjectKindMergePreviewRequestSchema,
  type MergeSubjectKindsRequest,
  type SubjectKindDto,
  type SubjectKindMergePreviewRequest,
  type SubjectKindMergePreviewResponse,
  type SubjectKindMergeSuggestionsResponse,
  type UpdateSubjectKindRequest,
} from '../../../shared/contracts/subject-kinds';
import type { Envelope } from '../../../shared/contracts/common';
import type { OkResponse } from '../../../shared/contracts/users';
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
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody } from '../http/zod-validation.pipe';

// Reading the catalogue and adding to it are open to anyone signed in, exactly as for people and
// subjects: the analysis adds a kind it meets, and whoever files a boat must not wait for an admin
// to invent "boat" (docs/03 §3.3.20a).
@Controller('subject-kinds')
@UseGuards(SessionGuard)
export class SubjectKindsController {
  constructor(
    private readonly list: ListSubjectKinds,
    private readonly createKind: CreateSubjectKind,
  ) {}

  @Get()
  async listKinds(): Promise<Envelope<ListSubjectKindsResponse>> {
    return successEnvelope(await this.list.execute());
  }

  @Post()
  async create(
    @ZodBody(createSubjectKindRequestSchema) body: CreateSubjectKindRequest,
  ): Promise<Envelope<SubjectKindDto>> {
    return successEnvelope(await this.createKind.execute(body));
  }
}

// Renaming reaches every thing filed under the kind, and removing is refused while any of them is
// alive — both are an admin's (docs/11 §11.12).
@Controller('admin/subject-kinds')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminSubjectKindsController {
  constructor(
    private readonly updateKind: UpdateSubjectKind,
    private readonly deleteKind: DeleteSubjectKind,
    private readonly mergeKinds: MergeSubjectKinds,
    private readonly suggestMerges: SuggestSubjectKindMerges,
    private readonly previewMerge: PreviewSubjectKindMerge,
  ) {}

  // Declared before `:id`, or the router reads "merge" as a kind id.
  @Post('merge')
  async merge(
    @ZodBody(mergeSubjectKindsRequestSchema) body: MergeSubjectKindsRequest,
  ): Promise<Envelope<SubjectKindDto>> {
    return successEnvelope(await this.mergeKinds.execute(body));
  }

  // The analyst's reading of the kinds catalogue (docs/05 §5.6c).
  @Get('merge-suggestions')
  async mergeSuggestions(): Promise<Envelope<SubjectKindMergeSuggestionsResponse>> {
    return successEnvelope(await this.suggestMerges.execute());
  }

  // A POST for the ids in its body, but a question — nothing is created (docs/11 §11.12a).
  @Post('merge-preview')
  @HttpCode(HttpStatus.OK)
  async mergePreview(
    @ZodBody(subjectKindMergePreviewRequestSchema) body: SubjectKindMergePreviewRequest,
  ): Promise<Envelope<SubjectKindMergePreviewResponse>> {
    return successEnvelope(await this.previewMerge.execute(body));
  }

  @Patch(':id')
  async update(
    @UuidParam('id', 'SUBJECT_KIND_NOT_FOUND', 'Subject kind') id: string,
    @ZodBody(updateSubjectKindRequestSchema) body: UpdateSubjectKindRequest,
  ): Promise<Envelope<SubjectKindDto>> {
    return successEnvelope(await this.updateKind.execute(id, body));
  }

  @Delete(':id')
  async remove(
    @UuidParam('id', 'SUBJECT_KIND_NOT_FOUND', 'Subject kind') id: string,
  ): Promise<Envelope<OkResponse>> {
    await this.deleteKind.execute(id);
    return successEnvelope({ ok: true });
  }
}
