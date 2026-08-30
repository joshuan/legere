import {
  createPersonRequestSchema,
  listPeopleResponseSchema,
  mergePeopleRequestSchema,
  peopleMergePreviewRequestSchema,
  peopleMergePreviewResponseSchema,
  peopleMergeSuggestionsResponseSchema,
  personDtoSchema,
  updatePersonRequestSchema,
  type CreatePersonRequest,
  type MergePeopleRequest,
  type PeopleMergePreviewRequest,
  type PeopleMergePreviewResponse,
  type PeopleMergeSuggestionsResponse,
  type PersonDto,
  type UpdatePersonRequest,
} from '../../../shared/contracts/people';
import type { CatalogueOrder, CatalogueSort } from '../../../shared/contracts/common';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, listAllPages, type CatalogueArrangement } from '../../shared/api';

export const personApi = {
  // The arrangement travels to the server with every page (docs/07 §7.3): a page of a ten-thousand
  // row catalogue sorted in the browser is a lie, and the cursor is bound to the sort that minted
  // it.
  list: (arrangement: CatalogueArrangement = {}): Promise<{ items: PersonDto[] }> =>
    listAllPages('/api/people', listPeopleResponseSchema, arrangement),

  // Open to anyone signed in: the analyst adds names on its own, and whoever corrects it must be
  // able to add the one it missed (docs/03 §3.3.19).
  create: (body: CreatePersonRequest): Promise<PersonDto> =>
    apiClient.post('/api/people', {
      schema: personDtoSchema,
      body: createPersonRequestSchema.parse(body),
    }),

  // Renaming and removing reach across every document that names the person, so they are an admin's
  // (docs/11 §11.12).
  update: (id: string, body: UpdatePersonRequest): Promise<PersonDto> =>
    apiClient.patch(`/api/admin/people/${id}`, {
      schema: personDtoSchema,
      body: updatePersonRequestSchema.parse(body),
    }),

  // Folding several rows into one reaches every document that named any of them (docs/03 §3.3.19).
  merge: (body: MergePeopleRequest): Promise<PersonDto> =>
    apiClient.post('/api/admin/people/merge', {
      schema: personDtoSchema,
      body: mergePeopleRequestSchema.parse(body),
    }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/people/${id}`, { schema: okResponseSchema }),

  // The analyst's reading of the catalogue: which rows are one person (docs/05 §5.6c). Nothing is
  // stored server-side; the answer is computed on request and cached against the catalogue's state,
  // and `refresh` drops that cached reading and asks anew — the Recompute of docs/11 §11.12a.
  mergeSuggestions: ({ refresh = false } = {}): Promise<PeopleMergeSuggestionsResponse> =>
    apiClient.get(`/api/admin/people/merge-suggestions${refresh ? '?refresh=1' : ''}`, {
      schema: peopleMergeSuggestionsResponseSchema,
    }),

  // The same reading for a hand-picked selection, so the merge dialog opens tidy (docs/11 §11.12a).
  mergePreview: (body: PeopleMergePreviewRequest): Promise<PeopleMergePreviewResponse> =>
    apiClient.post('/api/admin/people/merge-preview', {
      schema: peopleMergePreviewResponseSchema,
      body: peopleMergePreviewRequestSchema.parse(body),
    }),
};

export const personKeys = {
  all: ['people'] as const,
  // Under `all`, so invalidating the catalogue invalidates every arrangement of it.
  list: (sort: CatalogueSort, order: CatalogueOrder) => ['people', 'list', sort, order] as const,
  mergeSuggestions: ['people', 'merge-suggestions'] as const,
};
