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
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import type { ZodType } from 'zod';
import { apiClient } from '../../shared/api';

export const subjectApi = {
  list: (): Promise<{ items: SubjectDto[] }> =>
    listAll('/api/subjects', listSubjectsResponseSchema),

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
  // computed on request and cached against the catalogue's state.
  mergeSuggestions: (): Promise<SubjectMergeSuggestionsResponse> =>
    apiClient.get('/api/admin/subjects/merge-suggestions', {
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
  mergeSuggestions: ['subjects', 'merge-suggestions'] as const,
};

// The endpoint answers bounded pages (docs/07 §7.1, SEC-56); the screens want the whole catalogue,
// so the client walks the pages. A hundred rows per ask keeps it to one round trip for years.
async function listAll<T>(
  path: string,
  schema: ZodType<{ items: T[]; nextCursor: string | null }>,
): Promise<{ items: T[] }> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const query: string =
      cursor === null ? '?limit=100' : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const page: { items: T[]; nextCursor: string | null } = await apiClient.get(`${path}${query}`, {
      schema,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { items };
}
