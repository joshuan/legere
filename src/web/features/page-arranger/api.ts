import {
  documentDetailDtoSchema,
  type DocumentDetailDto,
} from '../../../shared/contracts/documents';
import {
  updateDocumentFileRequestSchema,
  type UpdateDocumentFileRequest,
} from '../../../shared/contracts/files';
import { apiClient } from '../../shared/api';

// The two routes the page strip needs (docs/07 §7.3). The save answers about the whole document,
// because a composition change is never local (docs/05 §5.6) — the pages of one file are part of
// what the canonical is built out of.
export const pageApi = {
  // Plain URL, not a fetch: an <img> points straight at it and the browser follows the 302 to the
  // signed URL itself (docs/10 §10.8). One page of the **original**, as it arrived, which is what
  // somebody putting pages in order looks at; `page` is 0-based, the way a page order counts
  // (docs/03 §3.3.16). The bytes are immutable, so the browser may cache it for as long as it likes.
  thumbUrl: (documentId: string, fileId: string, page: number): string =>
    `/api/documents/${documentId}/files/${fileId}/pages/${page}/thumb`,

  // The whole permutation, exactly as a file reorder sends the whole order; `pageOrder: null`
  // restores the order the file arrived in (docs/07 §7.3).
  save: (
    documentId: string,
    fileId: string,
    body: UpdateDocumentFileRequest,
  ): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${documentId}/files/${fileId}`, {
      schema: documentDetailDtoSchema,
      // Validated on the way out too: an order that is not a list of page indices is a bug in this
      // strip, and it should fail here rather than as a 422 the person has to interpret.
      body: updateDocumentFileRequestSchema.parse(body),
    }),
};
