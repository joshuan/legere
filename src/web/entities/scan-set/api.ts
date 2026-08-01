import {
  listScanSetsResponseSchema,
  scanSetDetailSchema,
  scanSetDtoSchema,
  type CreateScanSetRequest,
  type ListScanSetsResponse,
  type ScanSetDetailDto,
  type ScanSetDto,
  type UpdateScanSetRequest,
} from '../../../shared/contracts/scan-sets';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// Scan set endpoints (docs/07 §7.3).
export const scanSetApi = {
  list: (): Promise<ListScanSetsResponse> =>
    apiClient.get('/api/scan-sets', { schema: listScanSetsResponseSchema }),

  get: (id: string): Promise<ScanSetDetailDto> =>
    apiClient.get(`/api/scan-sets/${id}`, { schema: scanSetDetailSchema }),

  create: (body: CreateScanSetRequest): Promise<ScanSetDetailDto> =>
    apiClient.post('/api/scan-sets', { schema: scanSetDetailSchema, body }),

  update: (id: string, body: UpdateScanSetRequest): Promise<ScanSetDetailDto> =>
    apiClient.patch(`/api/scan-sets/${id}`, { schema: scanSetDetailSchema, body }),

  merge: (id: string): Promise<ScanSetDto> =>
    apiClient.post(`/api/scan-sets/${id}/merge`, { schema: scanSetDtoSchema }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/scan-sets/${id}`, { schema: okResponseSchema }),
};

export const scanSetKeys = {
  all: ['scan-sets'] as const,
  detail: (id: string) => ['scan-set', id] as const,
};
