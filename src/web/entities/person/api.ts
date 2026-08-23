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
  type ListPeopleResponse,
  type MergePeopleRequest,
  type PeopleMergePreviewRequest,
  type PeopleMergePreviewResponse,
  type PeopleMergeSuggestionsResponse,
  type PersonDto,
  type UpdatePersonRequest,
} from '../../../shared/contracts/people';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

export const personApi = {
  list: (): Promise<ListPeopleResponse> =>
    apiClient.get('/api/people', { schema: listPeopleResponseSchema }),

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
  // stored server-side; the answer is computed on request and cached against the catalogue's state.
  mergeSuggestions: (): Promise<PeopleMergeSuggestionsResponse> =>
    apiClient.get('/api/admin/people/merge-suggestions', {
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
  mergeSuggestions: ['people', 'merge-suggestions'] as const,
};
