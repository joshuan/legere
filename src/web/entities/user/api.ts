import {
  adminUserDtoSchema,
  createInviteResponseSchema,
  createPasswordResetResponseSchema,
  listInvitesResponseSchema,
  listUsersResponseSchema,
  okResponseSchema,
  revokeSessionsResponseSchema,
  type AdminUserDto,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type CreatePasswordResetResponse,
  type ListInvitesResponse,
  type ListUsersResponse,
  type OkResponse,
  type RevokeSessionsResponse,
} from '../../../shared/contracts/users';
import type { UserRole } from '../../../shared/contracts/enums';
import { apiClient } from '../../shared/api';

// Admin user and invite endpoints (docs/07 §7.3).
export const userApi = {
  list: (query: { limit?: number; cursor?: string } = {}): Promise<ListUsersResponse> =>
    apiClient.get('/api/admin/users', { schema: listUsersResponseSchema, query }),

  changeRole: (id: string, role: UserRole): Promise<AdminUserDto> =>
    apiClient.patch(`/api/admin/users/${id}`, { schema: adminUserDtoSchema, body: { role } }),

  deactivate: (id: string): Promise<AdminUserDto> =>
    apiClient.post(`/api/admin/users/${id}/deactivate`, { schema: adminUserDtoSchema }),

  reactivate: (id: string): Promise<AdminUserDto> =>
    apiClient.post(`/api/admin/users/${id}/reactivate`, { schema: adminUserDtoSchema }),

  revokeSessions: (id: string): Promise<RevokeSessionsResponse> =>
    apiClient.post(`/api/admin/users/${id}/revoke-sessions`, {
      schema: revokeSessionsResponseSchema,
    }),

  createPasswordReset: (id: string): Promise<CreatePasswordResetResponse> =>
    apiClient.post(`/api/admin/users/${id}/password-reset`, {
      schema: createPasswordResetResponseSchema,
    }),

  createInvite: (body: CreateInviteRequest): Promise<CreateInviteResponse> =>
    apiClient.post('/api/admin/invites', { schema: createInviteResponseSchema, body }),

  listInvites: (): Promise<ListInvitesResponse> =>
    apiClient.get('/api/admin/invites', { schema: listInvitesResponseSchema }),

  revokeInvite: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/invites/${id}`, { schema: okResponseSchema }),
};

export const userKeys = {
  list: ['admin', 'users'] as const,
  invites: ['admin', 'invites'] as const,
};
