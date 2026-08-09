import {
  invitePreviewSchema,
  logoutResponseSchema,
  onboardingStatusSchema,
  passwordResetPreviewSchema,
  registerStartResponseSchema,
  registerVerifyResponseSchema,
  userDtoSchema,
  type InvitePreview,
  type LoginRequest,
  type OnboardingStatus,
  type PasswordResetPreview,
  type RegisterCompleteRequest,
  type RegisterStartRequest,
  type RegisterStartResponse,
  type RegisterVerifyRequest,
  type RegisterVerifyResponse,
  type UserDto,
} from '../../../shared/contracts/auth';
import {
  changePasswordResponseSchema,
  listSessionsResponseSchema,
  okResponseSchema,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type ListSessionsResponse,
  type OkResponse,
  type UpdateMeRequest,
} from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// Session/account endpoints (docs/07 §7.3). Each call names the contract schema its response is
// validated against, so a drift between server and client fails at the boundary.

export const sessionApi = {
  onboardingStatus: (): Promise<OnboardingStatus> =>
    apiClient.get('/api/auth/onboarding', { schema: onboardingStatusSchema }),

  registerStart: (body: RegisterStartRequest): Promise<RegisterStartResponse> =>
    apiClient.post('/api/auth/register/start', { schema: registerStartResponseSchema, body }),

  registerVerify: (body: RegisterVerifyRequest): Promise<RegisterVerifyResponse> =>
    apiClient.post('/api/auth/register/verify', { schema: registerVerifyResponseSchema, body }),

  registerComplete: (body: RegisterCompleteRequest): Promise<UserDto> =>
    apiClient.post('/api/auth/register/complete', { schema: userDtoSchema, body }),

  login: (body: LoginRequest): Promise<UserDto> =>
    apiClient.post('/api/auth/login', { schema: userDtoSchema, body }),

  logout: (): Promise<{ ok: true }> =>
    apiClient.post('/api/auth/logout', { schema: logoutResponseSchema }),

  me: (): Promise<UserDto> => apiClient.get('/api/me', { schema: userDtoSchema }),

  updateMe: (body: UpdateMeRequest): Promise<UserDto> =>
    apiClient.patch('/api/me', { schema: userDtoSchema, body }),

  // An authenticated rotation (docs/08 §8.1.6a): every other session of this user ends with it.
  changePassword: (body: ChangePasswordRequest): Promise<ChangePasswordResponse> =>
    apiClient.post('/api/me/password', { schema: changePasswordResponseSchema, body }),

  listSessions: (): Promise<ListSessionsResponse> =>
    apiClient.get('/api/me/sessions', { schema: listSessionsResponseSchema }),

  revokeSession: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/me/sessions/${id}`, { schema: okResponseSchema }),

  previewInvite: (token: string): Promise<InvitePreview> =>
    apiClient.get(`/api/invites/${encodeURIComponent(token)}`, { schema: invitePreviewSchema }),

  previewPasswordReset: (token: string): Promise<PasswordResetPreview> =>
    apiClient.get(`/api/password-resets/${encodeURIComponent(token)}`, {
      schema: passwordResetPreviewSchema,
    }),
};

// Query keys for the session slice (docs/10 §10.5).
export const sessionKeys = {
  me: ['me'] as const,
  sessions: ['me', 'sessions'] as const,
  onboarding: ['auth', 'onboarding'] as const,
  invite: (token: string) => ['invite', token] as const,
  passwordReset: (token: string) => ['password-reset', token] as const,
};
