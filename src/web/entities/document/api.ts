import {
  documentDetailDtoSchema,
  documentGroupsResponseSchema,
  documentLinkDtoSchema,
  documentLinkSuggestionsResponseSchema,
  documentLinksResponseSchema,
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
  type DocumentLinkDto,
  type DocumentLinkSuggestionsResponse,
  type DocumentLinksResponse,
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
  moveDocumentPagesResponseSchema,
  splitDocumentFileResponseSchema,
  splitDocumentResponseSchema,
  type CombineDocumentsRequest,
  type GroupingSuggestionsResponse,
  type MoveDocumentPagesRequest,
  type MoveDocumentPagesResponse,
  type ReorderDocumentFilesRequest,
  type ReorderDocumentPagesRequest,
  type SplitDocumentFileResponse,
  type SplitDocumentRequest,
  type SplitDocumentResponse,
  type UpdateDocumentPageRequest,
} from '../../../shared/contracts/files';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, uploadFile, type UploadProgress } from '../../shared/api';

// Filters as the grid holds them: everything optional, everything mirrored in the URL (docs/11 §11.3).
// The contract's own set, so one added there arrives here rather than being kept in step by hand.
// The chosen order is not one of them — it lives in the URL beside them and survives "Clear
// filters", because arranging a shelf is not the same as narrowing it (docs/11 §11.3); neither is
// the grouping, nor which fields a card shows.
export type { DocumentFilters };

// How the grid is arranged, as one of the named orders of docs/07 §7.1. Absent is the contract's
// default, which leaves no trace in the URL the way an unset filter does not; which order that is is
// written down once, in the contract, and a screen that wants another one asks for it by name.
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

  // One page of the journal, the cursor naming where the last one ended (docs/07 §7.3): the log
  // tab pages through them with Show more rather than silently ending at the server's default.
  events: (id: string, cursor?: string): Promise<DocumentEventPage> =>
    apiClient.get(`/api/documents/${id}/events`, {
      schema: documentEventPageSchema,
      ...(cursor === undefined ? {} : { query: { cursor } }),
    }),

  // The edges of one document (docs/03 §3.3.23, docs/07 §7.3): undirected, person-made, and the
  // suggestions computed on request rather than remembered (docs/05 §5.6b).
  links: (id: string): Promise<DocumentLinksResponse> =>
    apiClient.get(`/api/documents/${id}/links`, { schema: documentLinksResponseSchema }),

  createLink: (id: string, documentId: string): Promise<DocumentLinkDto> =>
    apiClient.post(`/api/documents/${id}/links`, {
      body: { documentId },
      schema: documentLinkDtoSchema,
    }),

  deleteLink: (id: string, documentId: string): Promise<OkResponse> =>
    apiClient.delete(`/api/documents/${id}/links/${documentId}`, { schema: okResponseSchema }),

  linkSuggestions: (id: string): Promise<DocumentLinkSuggestionsResponse> =>
    apiClient.get(`/api/documents/${id}/link-suggestions`, {
      schema: documentLinkSuggestionsResponseSchema,
    }),

  // Composing a document out of pages (docs/07 §7.3 "Document pages and files"). Every one of these
  // answers with the whole document, because a composition change is never local — the canonical,
  // the preview, the text and the analysis are all rebuilt behind it (docs/05 §5.6) — and the answer
  // carries the page list the next request will index into (docs/03 §3.3.17).
  //
  // `at` is a place in that list, 0-based: the file's pages go **there** rather than after the last
  // one, which is what puts a photograph between page two and page three (docs/11 §11.5a). Absent is
  // the append this always was.
  addFile: (
    id: string,
    file: File,
    options: { at?: number; onProgress?: UploadProgress; signal?: AbortSignal } = {},
  ): Promise<DocumentDetailDto> =>
    uploadFile(
      options.at === undefined
        ? `/api/documents/${id}/files`
        : `/api/documents/${id}/files?at=${options.at}`,
      file,
      {
        schema: documentDetailDtoSchema,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    ),

  // The complete order, every page of the document exactly once (docs/07 §7.3): one request and one
  // truth, which is the only shape a reorder cannot be half applied in. "Move this page to position
  // three" is this request carrying the order that results from it.
  reorderPages: (id: string, body: ReorderDocumentPagesRequest): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${id}/pages`, { schema: documentDetailDtoSchema, body }),

  // What one page says about itself: how much of it is paper and which way up it lies
  // (docs/03 §3.3.17). `null` clears either and the page reads as it arrived; neither is ever a
  // change to the bytes.
  //
  // 🔒 The body is typed here rather than parsed against a contract schema, which every other write
  // on this client does: the schema arrives with the endpoint's own task and this screen is built
  // against the shape `07 §7.3` fixes for it. The **answer** is validated like every other, so a
  // drift still surfaces at the boundary rather than downstream.
  updatePage: (
    id: string,
    pageId: string,
    body: UpdateDocumentPageRequest,
  ): Promise<DocumentDetailDto> =>
    apiClient.patch(`/api/documents/${id}/pages/${pageId}`, {
      schema: documentDetailDtoSchema,
      body,
    }),

  // One page leaves and the rest close up behind it; the file it was read from goes to the trash
  // only if no live page anywhere still reads it (docs/05 §5.7a).
  removePage: (id: string, pageId: string): Promise<DocumentDetailDto> =>
    apiClient.delete(`/api/documents/${id}/pages/${pageId}`, { schema: documentDetailDtoSchema }),

  // The document cut at one or more page boundaries into two or more, over the same files and with
  // no bytes copied (docs/05 §5.6). The parts are linked to each other.
  splitAtPages: (id: string, body: SplitDocumentRequest): Promise<SplitDocumentResponse> =>
    apiClient.post(`/api/documents/${id}/split`, { schema: splitDocumentResponseSchema, body }),

  // The pages that belong elsewhere go there: an existing document at a chosen position, or a new
  // one made to hold them (`documentId: null`), which has one place to put them and takes no
  // position at all.
  movePages: (id: string, body: MoveDocumentPagesRequest): Promise<MoveDocumentPagesResponse> =>
    apiClient.post(`/api/documents/${id}/pages/move`, {
      schema: moveDocumentPagesResponseSchema,
      body,
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
  // One page of one original, as it arrived — what somebody putting pages in order looks at
  // (docs/07 §7.3). `page` is 0-based, the way a page entry counts (docs/03 §3.3.17).
  //
  // 🔒 A stored turn does not reach it: the picture is the page as it arrived and the strip turns
  // what it draws (docs/11 §11.5a). The cache key is bytes that cannot change, which is what lets
  // the browser keep it for as long as it likes.
  pageThumb: (documentId: string, fileId: string, page: number) =>
    `/api/documents/${documentId}/files/${fileId}/pages/${page}/thumb`,
};

export const documentKeys = {
  // The order is part of the key: rearranging the shelf is a different answer to a different
  // question, not the same page re-drawn (docs/11 §11.3).
  list: (filters: DocumentFilters, sort?: DocumentSort) => ['documents', filters, sort] as const,
  detail: (id: string) => ['document', id] as const,
  markdown: (id: string) => ['document', id, 'markdown'] as const,
  events: (id: string) => ['document', id, 'events'] as const,
  links: (id: string) => ['document', id, 'links'] as const,
  linkSuggestions: (id: string) => ['document', id, 'link-suggestions'] as const,
  years: ['documents', 'years'] as const,
  // Counted under whatever filters were in force, so those are part of the key: the same dimension
  // over a narrower shelf is a different answer (docs/07 §7.3).
  groups: (by: DocumentGroupBy, filters: DocumentFilters) =>
    ['documents', 'groups', by, filters] as const,
  groupingSuggestions: ['documents', 'grouping-suggestions'] as const,
};
