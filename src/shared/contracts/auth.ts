import { z } from 'zod';
import { languageSchema, themeSchema, userRoleSchema } from './enums';

// Auth contracts (docs/07 §7.3 "Auth & account", docs/08 §8.1). Used by the server to validate
// requests and by the client to validate responses and drive forms.

// Emails are normalized (trim + lower-case) before anything else looks at them (docs/08 §8.1.3).
export const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

// A short denylist of passwords that pass a length check but are trivially guessable. Kept small and
// exact-match (after lower-casing): the real defenses are Argon2id, rate limiting and CAPTCHA
// (docs/08 §8.4); this only stops the most careless choices.
export const PASSWORD_DENYLIST: ReadonlySet<string> = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyui',
  'qwerty123',
  'iloveyou',
  'admin123',
  'administrator',
  'letmein1',
  'welcome1',
  'legere',
  'legere123',
  'changeme',
  'secret123',
]);

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// Password rule (docs/08 §8.1.3): 8–128 characters and not in the denylist.
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .refine((value) => !PASSWORD_DENYLIST.has(value.toLowerCase()), {
    message: 'Password is too common',
  });

// The 6-digit email code (docs/08 §8.1.3 step 2).
export const emailCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Code must be 6 digits');

// Opaque bearer tokens: invite/reset URL tokens and the registration ticket. Never logged.
export const opaqueTokenSchema = z.string().min(16).max(256);

// UserDto (docs/07 §7.3) — never contains hashes.
export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
  language: languageSchema,
  theme: themeSchema,
  createdAt: z.string().datetime(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

// GET /api/auth/onboarding
export const onboardingStatusSchema = z.object({ required: z.boolean() });
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

// POST /api/auth/register/start — always answers 200 (anti-enumeration).
export const registerStartRequestSchema = z.object({
  email: emailSchema,
  inviteToken: opaqueTokenSchema.optional(),
  resetToken: opaqueTokenSchema.optional(),
  captchaToken: z.string().min(1).optional(),
});
export type RegisterStartRequest = z.infer<typeof registerStartRequestSchema>;

export const registerStartResponseSchema = z.object({ expiresAt: z.string().datetime() });
export type RegisterStartResponse = z.infer<typeof registerStartResponseSchema>;

// POST /api/auth/register/verify — the same link token step 1 accepted, echoed back. 🔒 An attempt
// is charged only to a caller who proves they hold the link the series was made from, so a stranger
// who knows only an address cannot spend somebody else's five guesses (docs/08 §8.1.3 step 2,
// SEC-57). Optional in the schema because the onboarding series is started with no link at all.
export const registerVerifyRequestSchema = z.object({
  email: emailSchema,
  code: emailCodeSchema,
  inviteToken: opaqueTokenSchema.optional(),
  resetToken: opaqueTokenSchema.optional(),
});
export type RegisterVerifyRequest = z.infer<typeof registerVerifyRequestSchema>;

export const registerVerifyResponseSchema = z.object({
  ticket: z.string(),
  expiresAt: z.string().datetime(),
});
export type RegisterVerifyResponse = z.infer<typeof registerVerifyResponseSchema>;

// POST /api/auth/register/complete — creates the user and sets the sid cookie.
export const registerCompleteRequestSchema = z.object({
  ticket: opaqueTokenSchema,
  password: passwordSchema,
});
export type RegisterCompleteRequest = z.infer<typeof registerCompleteRequestSchema>;

// POST /api/auth/login
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  captchaToken: z.string().min(1).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// POST /api/auth/logout
export const logoutResponseSchema = z.object({ ok: z.literal(true) });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

// POST /api/invites/preview and /api/password-resets/preview — the bearer secret stays in JSON and
// never enters an HTTP request URL (docs/07 §7.3, SEC-38).
export const credentialPreviewRequestSchema = z.object({ token: opaqueTokenSchema });
export type CredentialPreviewRequest = z.infer<typeof credentialPreviewRequestSchema>;

// Public invite preview, exposes no token material.
export const invitePreviewSchema = z.object({
  role: userRoleSchema,
  emailHint: z.string().nullable(),
  expiresAt: z.string().datetime(),
  valid: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

// Public password-reset preview — email is masked.
export const passwordResetPreviewSchema = z.object({
  email: z.string(),
  expiresAt: z.string().datetime(),
  valid: z.boolean(),
});
export type PasswordResetPreview = z.infer<typeof passwordResetPreviewSchema>;
