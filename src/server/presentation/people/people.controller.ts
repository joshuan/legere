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
  createPersonRequestSchema,
  listPeopleQuerySchema,
  mergePeopleRequestSchema,
  peopleMergePreviewRequestSchema,
  updatePersonRequestSchema,
  type CreatePersonRequest,
  type ListPeopleQuery,
  type MergePeopleRequest,
  type ListPeopleResponse,
  type PeopleMergePreviewRequest,
  type PeopleMergePreviewResponse,
  type PeopleMergeSuggestionsResponse,
  type PersonDto,
  type UpdatePersonRequest,
} from '../../../shared/contracts/people';
import {
  catalogueSuggestionsQuerySchema,
  type CatalogueSuggestionsQuery,
  type Envelope,
} from '../../../shared/contracts/common';
import type { OkResponse } from '../../../shared/contracts/users';
import {
  CreatePerson,
  DeletePerson,
  GetPerson,
  ListPeople,
  MergePeople,
  UpdatePerson,
} from '../../application/people/manage-people';
import {
  PreviewPeopleMerge,
  SuggestPeopleMerges,
} from '../../application/people/suggest-people-merges';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';

// Reading the catalogue and adding to it are open to anyone signed in: the analyst adds names on its
// own, and whoever corrects it must be able to add the one it missed without waiting for an admin
// (docs/03 §3.3.19).
@Controller('people')
@UseGuards(SessionGuard)
export class PeopleController {
  constructor(
    private readonly list: ListPeople,
    private readonly getPerson: GetPerson,
    private readonly createPerson: CreatePerson,
  ) {}

  @Get()
  async listPeople(
    @ZodQuery(listPeopleQuerySchema) query: ListPeopleQuery,
  ): Promise<Envelope<ListPeopleResponse>> {
    return successEnvelope(await this.list.execute(query));
  }

  // One row by id, because a page cannot answer for a row that is on another page
  // (docs/07 §7.3, docs/11 §11.4).
  @Get(':id')
  async person(
    @UuidParam('id', 'PERSON_NOT_FOUND', 'Person') id: string,
  ): Promise<Envelope<PersonDto>> {
    return successEnvelope(await this.getPerson.execute(id));
  }

  // 🔒 Rate-limited (SEC-56): every row lands in a namespace every other user reads, so one
  // account does not get to fill it at machine speed.
  @Post()
  @Throttled('catalogue')
  async create(
    @ZodBody(createPersonRequestSchema) body: CreatePersonRequest,
  ): Promise<Envelope<PersonDto>> {
    return successEnvelope(await this.createPerson.execute(body));
  }
}

// Renaming and removing reach across every document that names the person, so they are an admin's
// (docs/11 §11.13).
@Controller('admin/people')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminPeopleController {
  constructor(
    private readonly updatePerson: UpdatePerson,
    private readonly deletePerson: DeletePerson,
    private readonly mergePeople: MergePeople,
    private readonly suggestMerges: SuggestPeopleMerges,
    private readonly previewMerge: PreviewPeopleMerge,
  ) {}

  // Declared before `:id`, or the router reads "merge" as a person id.
  @Post('merge')
  async merge(
    @ZodBody(mergePeopleRequestSchema) body: MergePeopleRequest,
  ): Promise<Envelope<PersonDto>> {
    return successEnvelope(await this.mergePeople.execute(body));
  }

  // The analyst's reading of the living catalogue (docs/05 §5.6c): which rows are one person.
  // Computed on request and cached in-process; nothing stored, a refusal never remembered.
  // `?refresh=1` drops the cached reading and asks anew — the recompute of docs/11 §11.12a.
  @Get('merge-suggestions')
  async mergeSuggestions(
    @ZodQuery(catalogueSuggestionsQuerySchema) query: CatalogueSuggestionsQuery,
  ): Promise<Envelope<PeopleMergeSuggestionsResponse>> {
    return successEnvelope(await this.suggestMerges.execute({ refresh: query.refresh === true }));
  }

  // The same reading for rows an admin selected by hand, so the merge dialog opens tidy
  // (docs/11 §11.12a). A POST for the ids in its body, but a question — nothing is created.
  @Post('merge-preview')
  @HttpCode(HttpStatus.OK)
  async mergePreview(
    @ZodBody(peopleMergePreviewRequestSchema) body: PeopleMergePreviewRequest,
  ): Promise<Envelope<PeopleMergePreviewResponse>> {
    return successEnvelope(await this.previewMerge.execute(body));
  }

  @Patch(':id')
  async update(
    @UuidParam('id', 'PERSON_NOT_FOUND', 'Person') id: string,
    @ZodBody(updatePersonRequestSchema) body: UpdatePersonRequest,
  ): Promise<Envelope<PersonDto>> {
    return successEnvelope(await this.updatePerson.execute(id, body));
  }

  @Delete(':id')
  async remove(
    @UuidParam('id', 'PERSON_NOT_FOUND', 'Person') id: string,
  ): Promise<Envelope<OkResponse>> {
    await this.deletePerson.execute(id);
    return successEnvelope({ ok: true });
  }
}
