import {
  browseResponseSchema,
  libraryAdminDtoSchema,
  listLibrariesAdminResponseSchema,
  listLibrariesResponseSchema,
  listScanRunsResponseSchema,
  pathCandidatesResponseSchema,
  triggerScanResponseSchema,
  type CreateLibraryRequest,
  type BrowseResponse,
  type LibraryAdminDto,
  type ListLibrariesAdminResponse,
  type ListLibrariesResponse,
  type ListScanRunsResponse,
  type PathCandidatesResponse,
  type TriggerScanResponse,
  type UpdateLibraryRequest,
} from '../../../shared/contracts/libraries';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// Library endpoints (docs/07 §7.3).
export const libraryApi = {
  listAdmin: (): Promise<ListLibrariesAdminResponse> =>
    apiClient.get('/api/admin/libraries', { schema: listLibrariesAdminResponseSchema }),

  get: (id: string): Promise<LibraryAdminDto> =>
    apiClient.get(`/api/admin/libraries/${id}`, { schema: libraryAdminDtoSchema }),

  create: (body: CreateLibraryRequest): Promise<LibraryAdminDto> =>
    apiClient.post('/api/admin/libraries', { schema: libraryAdminDtoSchema, body }),

  update: (id: string, body: UpdateLibraryRequest): Promise<LibraryAdminDto> =>
    apiClient.patch(`/api/admin/libraries/${id}`, { schema: libraryAdminDtoSchema, body }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/libraries/${id}`, { schema: okResponseSchema }),

  scan: (id: string): Promise<TriggerScanResponse> =>
    apiClient.post(`/api/admin/libraries/${id}/scan`, { schema: triggerScanResponseSchema }),

  scans: (id: string, cursor?: string): Promise<ListScanRunsResponse> =>
    apiClient.get(`/api/admin/libraries/${id}/scans`, {
      schema: listScanRunsResponseSchema,
      query: cursor === undefined ? {} : { cursor },
    }),

  pathCandidates: (path: string): Promise<PathCandidatesResponse> =>
    apiClient.get('/api/admin/library-path-candidates', {
      schema: pathCandidatesResponseSchema,
      query: { path },
    }),

  // The caller's visible libraries, used by filters and browse roots (docs/11 §11.1).
  listVisible: (): Promise<ListLibrariesResponse> =>
    apiClient.get('/api/libraries', { schema: listLibrariesResponseSchema }),

  browse: (id: string, path: string, cursor?: string): Promise<BrowseResponse> =>
    apiClient.get(`/api/libraries/${id}/browse`, {
      schema: browseResponseSchema,
      query: { path, ...(cursor === undefined ? {} : { cursor }) },
    }),
};

export const libraryKeys = {
  admin: ['admin', 'libraries'] as const,
  detail: (id: string) => ['admin', 'library', id] as const,
  scans: (id: string) => ['admin', 'library', id, 'scans'] as const,
  candidates: (path: string) => ['admin', 'path-candidates', path] as const,
  visible: ['libraries'] as const,
  browse: (id: string, path: string) => ['library', id, 'browse', path] as const,
};
