import {
  documentDetailDtoSchema,
  documentMarkdownResponseSchema,
  listDocumentsResponseSchema,
  uploadDocumentResponseSchema,
  type UploadDocumentResponse,
  documentEventPageSchema,
  documentYearsResponseSchema,
  reprocessResponseSchema,
  type DocumentDetailDto,
  type DocumentEventPage,
  type DocumentYearsResponse,
  type DocumentMarkdownResponse,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ReprocessRequest,
  type ReprocessResponse,
  type UpdateDocumentRequest,
} from '../../../shared/contracts/documents';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, uploadFile } from '../../shared/api';

// Filters as the grid holds them: everything optional, everything mirrored in the URL (docs/11 §11.3).
export type DocumentFilters = Omit<ListDocumentsQuery, 'limit' | 'cursor'>;

// Document endpoints (docs/07 §7.3).
export const documentApi = {
  // The bytes go straight up; the response is the row the grid can show at once (docs/05 §5.1a).
  upload: (file: File): Promise<UploadDocumentResponse> =>
    uploadFile('/api/documents', file, { schema: uploadDocumentResponseSchema }),

  list: (filters: DocumentFilters, cursor?: string): Promise<ListDocumentsResponse> =>
    apiClient.get('/api/documents', {
      schema: listDocumentsResponseSchema,
      query: {
        ...filters,
        ...(filters.processing === undefined ? {} : { processing: String(filters.processing) }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),

  get: (id: string): Promise<DocumentDetailDto> =>
    apiClient.get(`/api/documents/${id}`, { schema: documentDetailDtoSchema }),

  markdown: (id: string): Promise<DocumentMarkdownResponse> =>
    apiClient.get(`/api/documents/${id}/markdown`, { schema: documentMarkdownResponseSchema }),

  update: (id: string, body: UpdateDocumentRequest): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${id}`, { schema: documentDetailDtoSchema, body }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/documents/${id}`, { schema: okResponseSchema }),

  reprocess: (id: string, body: ReprocessRequest = {}): Promise<ReprocessResponse> =>
    apiClient.post(`/api/documents/${id}/reprocess`, { schema: reprocessResponseSchema, body }),

  years: (): Promise<DocumentYearsResponse> =>
    apiClient.get('/api/documents/years', { schema: documentYearsResponseSchema }),

  events: (id: string): Promise<DocumentEventPage> =>
    apiClient.get(`/api/documents/${id}/events`, { schema: documentEventPageSchema }),
};

// The bytes are plain URLs, not fetches: an <img> or <object> points straight at them and the
// browser follows the 302 to the signed URL itself (docs/10 §10.8).
export const documentFiles = {
  thumb: (id: string) => `/api/documents/${id}/thumb`,
  preview: (id: string) => `/api/documents/${id}/preview`,
  source: (id: string) => `/api/documents/${id}/source`,
  canonical: (id: string) => `/api/documents/${id}/canonical`,
};

export const documentKeys = {
  list: (filters: DocumentFilters) => ['documents', filters] as const,
  detail: (id: string) => ['document', id] as const,
  markdown: (id: string) => ['document', id, 'markdown'] as const,
  events: (id: string) => ['document', id, 'events'] as const,
  years: ['documents', 'years'] as const,
};
