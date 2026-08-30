import {
  createSubjectKindRequestSchema,
  listSubjectKindsResponseSchema,
  mergeSubjectKindsRequestSchema,
  subjectKindDtoSchema,
  subjectKindMergePreviewRequestSchema,
  subjectKindMergePreviewResponseSchema,
  subjectKindMergeSuggestionsResponseSchema,
  updateSubjectKindRequestSchema,
  type CreateSubjectKindRequest,
  type MergeSubjectKindsRequest,
  type SubjectKindDto,
  type SubjectKindMergePreviewRequest,
  type SubjectKindMergePreviewResponse,
  type SubjectKindMergeSuggestionsResponse,
  type UpdateSubjectKindRequest,
} from '../../../shared/contracts/subject-kinds';
import type { CatalogueOrder, SubjectKindSort } from '../../../shared/contracts/common';
import { okResponseSchema } from '../../../shared/contracts/users';
import { apiClient, listAllPages, type CatalogueArrangement } from '../../shared/api';

export const subjectKindApi = {
  // Sorted by the server on the people endpoint's terms, its `?sort=` admitting `things` too
  // (docs/07 §7.3).
  list: (arrangement: CatalogueArrangement = {}): Promise<{ items: SubjectKindDto[] }> =>
    listAllPages('/api/subject-kinds', listSubjectKindsResponseSchema, arrangement),

  // Open to anyone signed in, like people and subjects: the analysis adds a kind it meets, and
  // whoever files a boat must not wait for an admin to invent "boat" (docs/03 §3.3.20a).
  create: (body: CreateSubjectKindRequest): Promise<SubjectKindDto> =>
    apiClient.post('/api/subject-kinds', {
      schema: subjectKindDtoSchema,
      body: createSubjectKindRequestSchema.parse(body),
    }),

  update: (id: string, body: UpdateSubjectKindRequest): Promise<SubjectKindDto> =>
    apiClient.patch(`/api/admin/subject-kinds/${id}`, {
      schema: subjectKindDtoSchema,
      body: updateSubjectKindRequestSchema.parse(body),
    }),

  remove: (id: string): Promise<{ ok: boolean }> =>
    apiClient.delete(`/api/admin/subject-kinds/${id}`, { schema: okResponseSchema }),

  // Folding shelves reaches every thing filed under any of them (docs/03 §3.3.20a).
  merge: (body: MergeSubjectKindsRequest): Promise<SubjectKindDto> =>
    apiClient.post('/api/admin/subject-kinds/merge', {
      schema: subjectKindDtoSchema,
      body: mergeSubjectKindsRequestSchema.parse(body),
    }),

  // The analyst's reading of the kinds catalogue (docs/05 §5.6c), `refresh` dropping the cached one
  // and asking anew (docs/11 §11.12a).
  mergeSuggestions: ({ refresh = false } = {}): Promise<SubjectKindMergeSuggestionsResponse> =>
    apiClient.get(`/api/admin/subject-kinds/merge-suggestions${refresh ? '?refresh=1' : ''}`, {
      schema: subjectKindMergeSuggestionsResponseSchema,
    }),

  mergePreview: (body: SubjectKindMergePreviewRequest): Promise<SubjectKindMergePreviewResponse> =>
    apiClient.post('/api/admin/subject-kinds/merge-preview', {
      schema: subjectKindMergePreviewResponseSchema,
      body: subjectKindMergePreviewRequestSchema.parse(body),
    }),
};

export const subjectKindKeys = {
  all: ['subject-kinds'] as const,
  // Under `all`, so invalidating the catalogue invalidates every arrangement of it.
  list: (sort: SubjectKindSort, order: CatalogueOrder) =>
    ['subject-kinds', 'list', sort, order] as const,
  mergeSuggestions: ['subject-kinds', 'merge-suggestions'] as const,
};
