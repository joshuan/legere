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
import { okResponseSchema } from '../../../shared/contracts/users';
import type { ZodType } from 'zod';
import { apiClient } from '../../shared/api';

export const subjectKindApi = {
  list: (): Promise<{ items: SubjectKindDto[] }> =>
    listAll('/api/subject-kinds', listSubjectKindsResponseSchema),

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

  // The analyst's reading of the kinds catalogue (docs/05 §5.6c).
  mergeSuggestions: (): Promise<SubjectKindMergeSuggestionsResponse> =>
    apiClient.get('/api/admin/subject-kinds/merge-suggestions', {
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
  mergeSuggestions: ['subject-kinds', 'merge-suggestions'] as const,
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
