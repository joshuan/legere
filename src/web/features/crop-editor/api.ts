import {
  cropSuggestionResponseSchema,
  type CropSuggestionResponse,
} from '../../../shared/contracts/files';
import { apiClient } from '../../shared/api';

// The routes the crop editor needs (docs/07 §7.3). What it stores it stores **on the page**
// (`PATCH /api/documents/:id/pages/:pageId`, docs/03 §3.3.17) — which is what lets two documents
// crop one photograph apart, and what lets a page of a PDF be cropped at all; that call is
// `documentApi.updatePage`, shared with the strip, so there is one way to say it.
export const cropApi = {
  // Plain URLs, not fetches: an <img> points straight at them and the browser follows the 302 to the
  // signed URL itself (docs/10 §10.8).
  contentUrl: (documentId: string, fileId: string): string =>
    `/api/documents/${documentId}/files/${fileId}/content`,

  // 🔒 A proposal, and only ever for an image: the detector reads a photograph of a page and the
  // endpoint refuses anything else (docs/05 §5.6). Nothing is stored until the person saves it.
  suggestion: (documentId: string, fileId: string): Promise<CropSuggestionResponse> =>
    apiClient.get(`/api/documents/${documentId}/files/${fileId}/crop-suggestion`, {
      schema: cropSuggestionResponseSchema,
    }),
};
