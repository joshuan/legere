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
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import type { ZodType } from 'zod';
import { apiClient } from '../../shared/api';

export const personApi = {
  list: (): Promise<{ items: PersonDto[] }> => listAll('/api/people', listPeopleResponseSchema),

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
