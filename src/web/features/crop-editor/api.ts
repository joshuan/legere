import {
  documentDetailDtoSchema,
  type DocumentDetailDto,
} from '../../../shared/contracts/documents';
import {
  cropSuggestionResponseSchema,
  updateDocumentFileRequestSchema,
  type CropSuggestionResponse,
  type UpdateDocumentFileRequest,
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

  // `crop: null` clears it and puts the whole file back into the canonical.
  save: (
    documentId: string,
    fileId: string,
    body: UpdateDocumentFileRequest,
  ): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${documentId}/files/${fileId}`, {
      schema: documentDetailDtoSchema,
      // Validated on the way out too: a point outside 0…1 is a bug in this editor, and it should
      // fail here rather than as a 422 the person has to interpret.
      body: updateDocumentFileRequestSchema.parse(body),
    }),
};
