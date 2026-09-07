import {
  convertArchiveItemResponseSchema,
  listReceiptsResponseSchema,
  receiptArtifactUrlSchema,
  receiptDetailSchema,
  uploadReceiptResponseSchema,
  type ConvertArchiveItemResponse,
  type ListReceiptsResponse,
  type ReceiptArtifactUrl,
  type ReceiptDetailDto,
  type UploadReceiptResponse,
} from '../../../shared/contracts/receipts';
import { errorBodySchema } from '../../../shared/contracts/common';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient, ApiError, type UploadProgress } from '../../shared/api';

export const receiptKeys = {
  all: ['receipts'] as const,
  list: ['receipts', 'list'] as const,
  detail: (id: string) => ['receipts', 'detail', id] as const,
  artifact: (id: string, kind: string) => ['receipts', 'artifact', id, kind] as const,
};

export const receiptApi = {
  upload: (
    file: File,
    onProgress?: UploadProgress,
    sourceText?: string,
  ): Promise<UploadReceiptResponse> => uploadReceipt(file, onProgress, sourceText),
  list: (cursor?: string): Promise<ListReceiptsResponse> =>
    apiClient.get('/api/receipts', {
      schema: listReceiptsResponseSchema,
      ...(cursor === undefined ? {} : { query: { cursor } }),
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
