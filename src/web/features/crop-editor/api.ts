import {
  documentDetailDtoSchema,
  type DocumentDetailDto,
} from '../../../shared/contracts/documents';
import {
  cropSuggestionResponseSchema,
  updateDocumentPageRequestSchema,
  type CropSuggestionResponse,
  type UpdateDocumentPageRequest,
} from '../../../shared/contracts/files';
import { apiClient } from '../../shared/api';

// The two routes the crop editor needs (docs/07 §7.3). Both answer about the whole document,
// because a composition change is never local (docs/05 §5.6).
export const cropApi = {
  // Plain URL, not a fetch: an <img> points straight at it and the browser follows the 302 to the
  // signed URL itself (docs/10 §10.8).
  contentUrl: (documentId: string, fileId: string): string =>
    `/api/documents/${documentId}/files/${fileId}/content`,

  // A proposal; nothing is stored until the person saves it (docs/05 §5.6).
  suggestion: (documentId: string, fileId: string): Promise<CropSuggestionResponse> =>
    apiClient.get(`/api/documents/${documentId}/files/${fileId}/crop-suggestion`, {
      schema: cropSuggestionResponseSchema,
    }),

  // The crop and the turn of **one page** (docs/07 §7.3): they are one question about one page, so
  // they are one request and one rebuild. `crop: null` clears it and the page goes back into the
  // canonical whole.
  save: (
    documentId: string,
    pageId: string,
    body: UpdateDocumentPageRequest,
  ): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${documentId}/pages/${pageId}`, {
      schema: documentDetailDtoSchema,
      // Validated on the way out too: a point outside 0…1 is a bug in this editor, and it should
      // fail here rather than as a 422 the person has to interpret.
      body: updateDocumentPageRequestSchema.parse(body),
    }),
};
