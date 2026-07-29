import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import { languageSchema, themeSchema, userRoleSchema } from './enums';

// Me & admin user/invite/reset contracts (docs/07 §7.3 "Auth & account", "Admin: users & invites").

// PATCH /api/me — every field optional; absent means "leave unchanged" (docs/07 §7.4).
export const updateMeRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    language: languageSchema.optional(),
    theme: themeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

// GET /api/admin/users — paginated, sorted by createdAt asc.
export const adminUserDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
  deactivatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type AdminUserDto = z.infer<typeof adminUserDtoSchema>;

export const listUsersQuerySchema = paginationQuerySchema;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const listUsersResponseSchema = paginatedSchema(adminUserDtoSchema);
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;

// PATCH /api/admin/users/:id — role change (LAST_ADMIN guarded).
export const updateUserRequestSchema = z
  .object({ role: userRoleSchema.optional() })
  .refine((value) => value.role !== undefined, { message: 'At least one field must be provided' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

// POST /api/admin/users/:id/revoke-sessions
export const revokeSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeSessionsResponse = z.infer<typeof revokeSessionsResponseSchema>;

// POST /api/admin/users/:id/password-reset — the URL is returned exactly once (docs/07 §7.4).
export const createPasswordResetResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type CreatePasswordResetResponse = z.infer<typeof createPasswordResetResponseSchema>;

// POST /api/admin/invites — the token appears only in this response.
export const createInviteRequestSchema = z.object({
  role: userRoleSchema,
  emailHint: z.string().trim().toLowerCase().email().max(254).optional(),
});
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const createInviteResponseSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  role: userRoleSchema,
  expiresAt: z.string().datetime(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

// GET /api/admin/invites — active invites, without tokens.
export const inviteDtoSchema = z.object({
  id: z.string().uuid(),
  role: userRoleSchema,
  emailHint: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;

export const listInvitesResponseSchema = z.object({ items: z.array(inviteDtoSchema) });
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

// DELETE /api/admin/invites/:id
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

// GET /api/users/lookup?q= — minimal directory for the share picker, max 10 active users.
export const userLookupQuerySchema = z.object({ q: z.string().trim().min(1).max(128) });
export type UserLookupQuery = z.infer<typeof userLookupQuerySchema>;

export const userLookupItemSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
});
export type UserLookupItem = z.infer<typeof userLookupItemSchema>;

export const userLookupResponseSchema = z.array(userLookupItemSchema).max(10);
export type UserLookupResponse = z.infer<typeof userLookupResponseSchema>;
