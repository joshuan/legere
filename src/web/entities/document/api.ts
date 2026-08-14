import {
  documentDetailDtoSchema,
  documentGroupsResponseSchema,
  documentMarkdownResponseSchema,
  listDocumentsResponseSchema,
  uploadDocumentResponseSchema,
  type UploadDocumentResponse,
  documentEventPageSchema,
  documentYearsResponseSchema,
  reprocessResponseSchema,
  type DocumentDetailDto,
  type DocumentEventPage,
  type DocumentFilters,
  type DocumentGroupBy,
  type DocumentGroupsResponse,
  type DocumentSort,
  type DocumentYearsResponse,
  type DocumentMarkdownResponse,
  type ListDocumentsResponse,
  type ReprocessRequest,
  type ReprocessResponse,
  type UpdateDocumentRequest,
} from '../../../shared/contracts/documents';
import {
  groupingSuggestionsResponseSchema,
  splitDocumentFileResponseSchema,
  type CombineDocumentsRequest,
  type GroupingSuggestionsResponse,
  type ReorderDocumentFilesRequest,
  type SplitDocumentFileResponse,
} from '../../../shared/contracts/files';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, uploadFile, type UploadProgress } from '../../shared/api';

// Filters as the grid holds them: everything optional, everything mirrored in the URL (docs/11 §11.3).
// The contract's own set, so one added there arrives here rather than being kept in step by hand.
// The chosen order is not one of them — it lives in the URL beside them and survives "Clear
// filters", because arranging a shelf is not the same as narrowing it (docs/11 §11.3); neither is
// the grouping, nor which fields a card shows.
export type { DocumentFilters };

// How the grid is arranged, as one of the named orders of docs/07 §7.1. Absent is the default —
// the date on the document — and leaves no trace in the URL, the way an unset filter does not.
export type DocumentListOptions = { sort?: DocumentSort | undefined; cursor?: string | undefined };

// Document endpoints (docs/07 §7.3).
export const documentApi = {
  // The bytes go straight up; the response is the row the grid can show at once (docs/05 §5.1a).
  // A caller that draws a progress bar passes `onProgress`; one that does not is not charged for it.
  // `signal` is what a queue that can be emptied mid-flight needs: the request stops with it.
  upload: (
    file: File,
    onProgress?: UploadProgress,
    signal?: AbortSignal,
  ): Promise<UploadDocumentResponse> =>
    uploadFile('/api/documents', file, {
      schema: uploadDocumentResponseSchema,
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(signal === undefined ? {} : { signal }),
    }),

  list: (
    filters: DocumentFilters,
    options: DocumentListOptions = {},
  ): Promise<ListDocumentsResponse> =>
    apiClient.get('/api/documents', {
      schema: listDocumentsResponseSchema,
      query: {
        ...filters,
        ...(filters.processing === undefined ? {} : { processing: String(filters.processing) }),
        ...(options.sort === undefined ? {} : { sort: options.sort }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
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

  // The shelves of one dimension, counted under the filters given (docs/07 §7.3). Which filters
  // those are is the caller's decision: the screen leaves out the one the shelves themselves set,
  // or picking a shelf would collapse the list of them to the shelf being stood on (docs/11 §11.3).
  groups: (by: DocumentGroupBy, filters: DocumentFilters): Promise<DocumentGroupsResponse> =>
    apiClient.get('/api/documents/groups', {
      schema: documentGroupsResponseSchema,
      query: {
        ...filters,
        ...(filters.processing === undefined ? {} : { processing: String(filters.processing) }),
        by,
      },
    }),

  events: (id: string): Promise<DocumentEventPage> =>
    apiClient.get(`/api/documents/${id}/events`, { schema: documentEventPageSchema }),

  // Composing a document out of files (docs/07 §7.3 "Document files"). Every one of these answers
  // with the whole document, because a composition change is never local — the canonical, the
  // preview, the text and the analysis are all rebuilt behind it (docs/05 §5.6).
  addFile: (
    id: string,
    file: File,
    onProgress?: UploadProgress,
    signal?: AbortSignal,
  ): Promise<DocumentDetailDto> =>
    uploadFile(`/api/documents/${id}/files`, file, {
      schema: documentDetailDtoSchema,
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(signal === undefined ? {} : { signal }),
    }),

  // The same bytes on the same terms, sent in place of a file rather than after it: the new scan
  // takes the named file's position, so the page order does not move (docs/05 §5.6). One request
  // because it is one intention — split, upload, reorder is three of them to say that a page was
  // re-photographed. What it displaces is not destroyed: it goes to the trash and stays listed under
  // its successor as an earlier version (docs/05 §5.7a).
  replaceFile: (
    id: string,
    fileId: string,
    file: File,
    onProgress?: UploadProgress,
  ): Promise<DocumentDetailDto> =>
    uploadFile(`/api/documents/${id}/files/${fileId}/replacement`, file, {
      schema: documentDetailDtoSchema,
      ...(onProgress === undefined ? {} : { onProgress }),
    }),

  reorderFiles: (id: string, body: ReorderDocumentFilesRequest): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${id}/files`, { schema: documentDetailDtoSchema, body }),

  // A split, not a deletion: the file leaves this document and becomes one of its own, which is why
  // the answer names both (docs/11 §11.5a). The crop of a single file is the crop editor's own
  // business and lives with it (docs/11 §11.5c).
  splitFile: (id: string, fileId: string): Promise<SplitDocumentFileResponse> =>
    apiClient.delete(`/api/documents/${id}/files/${fileId}`, {
      schema: splitDocumentFileResponseSchema,
    }),

  // The files of those documents, appended to this one in that order; the emptied ones go away.
  combine: (id: string, body: CombineDocumentsRequest): Promise<DocumentDetailDto> =>
    apiClient.post(`/api/documents/${id}/combine`, { schema: documentDetailDtoSchema, body }),

  // What looks like one document scanned page by page (docs/05 §5.6a). Computed, never stored — so
  // it is asked for afresh rather than cached across a session.
  groupingSuggestions: (): Promise<GroupingSuggestionsResponse> =>
    apiClient.get('/api/documents/grouping-suggestions', {
      schema: groupingSuggestionsResponseSchema,
    }),
};

// The bytes are plain URLs, not fetches: an <img> or <object> points straight at them and the
// browser follows the 302 to the signed URL itself (docs/10 §10.8).
export const documentFiles = {
  thumb: (id: string) => `/api/documents/${id}/thumb`,
  preview: (id: string) => `/api/documents/${id}/preview`,
  // The document as one piece. `download` asks for it as an attachment rather than inline, which is
  // the only difference between reading it and keeping it (docs/11 §11.5b).
  canonical: (id: string, options: { download?: boolean } = {}) =>
    options.download === true
      ? `/api/documents/${id}/canonical?download=1`
      : `/api/documents/${id}/canonical`,
  // One original, exactly as it arrived (docs/07 §7.3).
  fileContent: (documentId: string, fileId: string) =>
    `/api/documents/${documentId}/files/${fileId}/content`,
};

export const documentKeys = {
  // The order is part of the key: rearranging the shelf is a different answer to a different
  // question, not the same page re-drawn (docs/11 §11.3).
  list: (filters: DocumentFilters, sort?: DocumentSort) => ['documents', filters, sort] as const,
  detail: (id: string) => ['document', id] as const,
  markdown: (id: string) => ['document', id, 'markdown'] as const,
  events: (id: string) => ['document', id, 'events'] as const,
  years: ['documents', 'years'] as const,
  // Counted under whatever filters were in force, so those are part of the key: the same dimension
  // over a narrower shelf is a different answer (docs/07 §7.3).
  groups: (by: DocumentGroupBy, filters: DocumentFilters) =>
    ['documents', 'groups', by, filters] as const,
  groupingSuggestions: ['documents', 'grouping-suggestions'] as const,
};
