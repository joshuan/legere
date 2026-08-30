import {
  createSubjectRequestSchema,
  listSubjectsResponseSchema,
  mergeSubjectsRequestSchema,
  subjectDtoSchema,
  subjectMergePreviewRequestSchema,
  subjectMergePreviewResponseSchema,
  subjectMergeSuggestionsResponseSchema,
  updateSubjectRequestSchema,
  type CreateSubjectRequest,
  type MergeSubjectsRequest,
  type SubjectDto,
  type SubjectMergePreviewRequest,
  type SubjectMergePreviewResponse,
  type SubjectMergeSuggestionsResponse,
  type UpdateSubjectRequest,
} from '../../../shared/contracts/subjects';
import type { CatalogueOrder, CatalogueSort } from '../../../shared/contracts/common';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, listAllPages, type CatalogueArrangement } from '../../shared/api';

export const subjectApi = {
  // Sorted by the server, page by page, on the people endpoint's terms (docs/07 §7.3).
  list: (arrangement: CatalogueArrangement = {}): Promise<{ items: SubjectDto[] }> =>
    listAllPages('/api/subjects', listSubjectsResponseSchema, arrangement),

  // Open to anyone signed in, like people: the analysis adds things on its own (docs/03 §3.3.20).
  create: (body: CreateSubjectRequest): Promise<SubjectDto> =>
    apiClient.post('/api/subjects', {
      schema: subjectDtoSchema,
      body: createSubjectRequestSchema.parse(body),
    }),

  // Renaming and removing reach across every document about that thing, so they are an admin's
  // (docs/11 §11.12).
  update: (id: string, body: UpdateSubjectRequest): Promise<SubjectDto> =>
    apiClient.patch(`/api/admin/subjects/${id}`, {
      schema: subjectDtoSchema,
      body: updateSubjectRequestSchema.parse(body),
    }),

  // Folding several rows into one reaches every document about any of them (docs/03 §3.3.20).
  merge: (body: MergeSubjectsRequest): Promise<SubjectDto> =>
    apiClient.post('/api/admin/subjects/merge', {
      schema: subjectDtoSchema,
      body: mergeSubjectsRequestSchema.parse(body),
    }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/subjects/${id}`, { schema: okResponseSchema }),

  // The analyst's reading of the things catalogue, kind-aware (docs/05 §5.6c): nothing stored,
  // computed on request and cached against the catalogue's state; `refresh` drops that reading and
  // asks anew (docs/11 §11.12a).
  mergeSuggestions: ({ refresh = false } = {}): Promise<SubjectMergeSuggestionsResponse> =>
    apiClient.get(`/api/admin/subjects/merge-suggestions${refresh ? '?refresh=1' : ''}`, {
      schema: subjectMergeSuggestionsResponseSchema,
    }),

  // The same reading for a hand-picked selection, the kind included (docs/11 §11.12a).
  mergePreview: (body: SubjectMergePreviewRequest): Promise<SubjectMergePreviewResponse> =>
    apiClient.post('/api/admin/subjects/merge-preview', {
      schema: subjectMergePreviewResponseSchema,
      body: subjectMergePreviewRequestSchema.parse(body),
    }),
};

export const subjectKeys = {
  all: ['subjects'] as const,
  // Under `all`, so invalidating the catalogue invalidates every arrangement of it.
  list: (sort: CatalogueSort, order: CatalogueOrder) => ['subjects', 'list', sort, order] as const,
  mergeSuggestions: ['subjects', 'merge-suggestions'] as const,
};
