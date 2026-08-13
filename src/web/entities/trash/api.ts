import {
  emptyTrashResponseSchema,
  listTrashResponseSchema,
  restoreTrashResponseSchema,
  type EmptyTrashResponse,
  type ListTrashResponse,
  type RestoreTrashResponse,
} from '../../../shared/contracts/trash';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// The trash (docs/07 §7.3 "Admin: the trash"): every file that has left a document and has not been
// destroyed yet. An admin's, because each of these either destroys bytes or makes a document.
export const trashApi = {
  // Newest first, paginated on `trashedAt` (docs/07 §7.1). The answer carries the whole trash's
  // weight beside the page, which is the question the screen exists to answer (docs/11 §11.13b).
  list: (cursor?: string): Promise<ListTrashResponse> =>
    apiClient.get('/api/admin/trash', {
      schema: listTrashResponseSchema,
      query: cursor === undefined ? {} : { cursor },
    }),

  // For good: the row goes, a MANAGED file's object with it, and a LIBRARY file's refs are left
  // EXCLUDED so the next scan does not ingest those bytes all over again (docs/05 §5.7a).
  remove: (fileId: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/trash/${fileId}`, { schema: okResponseSchema }),

  // Everything in it, not "what is due": the retention window says when an item goes at the latest,
  // and this is a person saying now (docs/07 §7.3).
  empty: (): Promise<EmptyTrashResponse> =>
    apiClient.delete('/api/admin/trash', { schema: emptyTrashResponseSchema }),

  // The file becomes a **new** document holding exactly it — never the document it came from, which
  // has moved on or is gone — so the answer is where to go and look at it (docs/05 §5.7a).
  restore: (fileId: string): Promise<RestoreTrashResponse> =>
    apiClient.post(`/api/admin/trash/${fileId}/restore`, { schema: restoreTrashResponseSchema }),
};

export const trashKeys = {
  list: ['admin', 'trash'] as const,
};
