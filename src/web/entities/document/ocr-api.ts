import {
  ocrResultSchema,
  ocrRunDtoSchema,
  ocrRunsResponseSchema,
  type StartOcrRequest,
} from '../../../shared/contracts/page-ocr';
import { apiClient } from '../../shared/api';

const root = (id: string) => `/api/documents/${id}`;
export const documentOcrApi = {
  list: (id: string) => apiClient.get(`${root(id)}/ocr-runs`, { schema: ocrRunsResponseSchema }),
  start: (id: string, body: StartOcrRequest) =>
    apiClient.post(`${root(id)}/ocr-runs`, { schema: ocrRunDtoSchema, body }),
  retry: (id: string, runId: string) =>
    apiClient.post(`${root(id)}/ocr-runs/${runId}/retry`, { schema: ocrRunDtoSchema }),
  result: (id: string, resultId: string) =>
    apiClient.get(`${root(id)}/ocr-results/${resultId}`, { schema: ocrResultSchema }),
  artifact: (id: string, resultId: string, kind: 'image' | 'raw' | 'json') =>
    `${root(id)}/ocr-results/${resultId}/${kind}`,
  image: (id: string, pageId: string) => `${root(id)}/ocr-pages/${pageId}/image`,
};
