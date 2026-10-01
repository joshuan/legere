import {
  receiptDuplicatePageSchema,
  receiptDuplicatePairSchema,
  receiptReviewSchema,
  receiptReviewPageSchema,
  type ReceiptPairQuery,
  type ResolveReceiptPair,
} from '../../../shared/contracts/receipt-duplicates';
import {
  convertArchiveItemResponseSchema,
  listReceiptsResponseSchema,
  receiptArtifactUrlSchema,
  receiptDetailSchema,
  uploadReceiptResponseSchema,
  type ConvertArchiveItemResponse,
  type ListReceiptsResponse,
  type ReceiptFilters,
  type ReceiptArtifactUrl,
  type ReceiptDetailDto,
  type ReceiptSort,
  type UploadReceiptResponse,
} from '../../../shared/contracts/receipts';
import { errorBodySchema } from '../../../shared/contracts/common';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, ApiError, type UploadProgress } from '../../shared/api';

export const receiptKeys = {
  all: ['receipts'] as const,
  lists: ['receipts', 'list'] as const,
  duplicates: ['receipts', 'duplicates'] as const,
  comparison: (pair: ReceiptPairQuery | null) => ['receipts', 'comparison', pair] as const,
  reviews: ['receipts', 'reviews'] as const,
  list: (filters: ReceiptFilters, sort: ReceiptSort) =>
    ['receipts', 'list', filters, sort] as const,
  detail: (id: string) => ['receipts', 'detail', id] as const,
  artifact: (id: string, kind: string) => ['receipts', 'artifact', id, kind] as const,
};

export const receiptApi = {
  duplicates: (cursor?: string) =>
    apiClient.get('/api/receipts/duplicates', {
      schema: receiptDuplicatePageSchema,
      query: { cursor: cursor === '' ? undefined : cursor },
    }),
  compare: (pair: ReceiptPairQuery) =>
    apiClient.get('/api/receipts/duplicates/compare', {
      schema: receiptDuplicatePairSchema,
      query: pair,
    }),
  resolve: (body: ResolveReceiptPair) =>
    apiClient.post('/api/receipts/duplicates/resolve', {
      schema: receiptReviewSchema,
      body,
    }),
  reviews: (cursor?: string) =>
    apiClient.get('/api/receipts/duplicates/history', {
      schema: receiptReviewPageSchema,
      query: { cursor: cursor === '' ? undefined : cursor },
    }),
  undoReview: (id: string) =>
    apiClient.post(`/api/receipts/duplicates/history/${id}/undo`, {
      schema: receiptReviewSchema,
    }),
  reviewOriginal: (id: string, side: 0 | 1) =>
    apiClient.get(`/api/receipts/duplicates/history/${id}/originals/${side}`, {
      schema: receiptArtifactUrlSchema,
    }),
  upload: (
    file: File,
    onProgress?: UploadProgress,
    sourceText?: string,
  ): Promise<UploadReceiptResponse> => uploadReceipt(file, onProgress, sourceText),
  list: (
    filters: ReceiptFilters,
    options: { sort?: ReceiptSort | undefined; cursor?: string | undefined } = {},
  ): Promise<ListReceiptsResponse> =>
    apiClient.get('/api/receipts', {
      schema: listReceiptsResponseSchema,
      query: {
        ...filters,
        ...(options.sort === undefined ? {} : { sort: options.sort }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
    }),
  get: (id: string): Promise<ReceiptDetailDto> =>
    apiClient.get(`/api/receipts/${id}`, { schema: receiptDetailSchema }),
  original: (id: string): Promise<ReceiptArtifactUrl> =>
    apiClient.get(`/api/receipts/${id}/original`, { schema: receiptArtifactUrlSchema }),
  download: (id: string): Promise<ReceiptArtifactUrl> =>
    apiClient.get(`/api/receipts/${id}/download`, { schema: receiptArtifactUrlSchema }),
  thumbnail: (id: string): Promise<ReceiptArtifactUrl> =>
    apiClient.get(`/api/receipts/${id}/thumbnail`, { schema: receiptArtifactUrlSchema }),
  page: (id: string, page: number): Promise<ReceiptArtifactUrl> =>
    apiClient.get(`/api/receipts/${id}/pages/${page}`, { schema: receiptArtifactUrlSchema }),
  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/receipts/${id}`, { schema: okResponseSchema }),
  convert: (id: string, kind: 'DOCUMENT' | 'RECEIPT'): Promise<ConvertArchiveItemResponse> =>
    apiClient.patch(`/api/archive-items/${id}/kind`, {
      schema: convertArchiveItemResponseSchema,
      body: { kind },
    }),
};

function uploadReceipt(
  file: File,
  onProgress?: UploadProgress,
  sourceText?: string,
): Promise<UploadReceiptResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/receipts');
    xhr.withCredentials = true;
    if (onProgress !== undefined) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }
    xhr.onerror = () => reject(new ApiError('NETWORK', 0));
    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = errorBodySchema.safeParse(payload);
        if (error.success) {
          reject(new ApiError(error.data.error.code, xhr.status, error.data.error.details ?? null));
          return;
        }
        reject(new ApiError('INTERNAL', xhr.status));
        return;
      }
      if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
        reject(new ApiError('INTERNAL', xhr.status));
        return;
      }
      const parsed = uploadReceiptResponseSchema.safeParse(payload.data);
      if (!parsed.success) {
        reject(new ApiError('INTERNAL', xhr.status));
        return;
      }
      resolve(parsed.data);
    };
    const body = new FormData();
    body.append('file', file, file.name);
    if (sourceText !== undefined) body.append('text', sourceText);
    xhr.send(body);
  });
}
