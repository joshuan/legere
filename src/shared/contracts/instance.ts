import { z } from 'zod';

// The admin's read-only view of what this server resolved its configuration to (docs/07 §7.3,
// docs/11 §11.13a).

// Where a value came from — or, for a secret, the fact that there is one. 🔒 A secret never travels
// as a value: `SET` says one is configured and says nothing else about it.
export const settingSourceSchema = z.enum(['ENV', 'DEFAULT', 'SET', 'UNSET']);
export type SettingSource = z.infer<typeof settingSourceSchema>;

// What a value nobody set costs, as a token rather than a sentence. The server knows how the
// pipeline degrades; the client knows the operator's language, and the two are not the same
// knowledge — so this names the outcome and the message catalog says it in ru or en (docs/07 §7.3,
// docs/11 §11.13a). Named for what happens, not for the variable that failed to happen it.
export const CONSEQUENCES = [
  // storage
  'SIGNED_URLS_USE_INTERNAL_ENDPOINT',
  // library
  'SCAN_UNLIMITED',
  // processing
  'MARKDOWN_FALLS_BACK_TO_STIRLING',
  // ai
  'VECTORIZATION_SKIPPED_NO_PROVIDER',
  'VECTORIZATION_SKIPPED_NO_MODEL',
  'ANALYSIS_SKIPPED_NO_PROVIDER',
  'ANALYSIS_USES_EMBEDDINGS_PROVIDER',
  'ANALYSIS_SKIPPED_NO_MODEL',
  // email
  'EMAIL_CODES_TO_LOG',
  // auth
  'COOKIE_NOT_SHARED_WITH_SUBDOMAINS',
  'CAPTCHA_DISABLED',
  'CAPTCHA_WIDGET_ABSENT',
] as const;

export const consequenceSchema = z.enum(CONSEQUENCES);
export type Consequence = z.infer<typeof consequenceSchema>;

export const instanceSettingSchema = z.object({
  key: z.string(),
  // Absent for a secret, and for anything nobody configured.
  value: z.string().nullable(),
  source: settingSourceSchema,
  // What its absence costs, where that is worth saying — most rows have nothing to say.
  consequence: consequenceSchema.nullable(),
});
export type InstanceSettingDto = z.infer<typeof instanceSettingSchema>;

export const instanceGroupSchema = z.object({
  key: z.enum([
    'core',
    'database',
    'storage',
    'library',
    'processing',
    'ai',
    'email',
    'auth',
    'queue',
  ]),
  settings: z.array(instanceSettingSchema),
});
export type InstanceGroupDto = z.infer<typeof instanceGroupSchema>;

export const instanceResponseSchema = z.object({ groups: z.array(instanceGroupSchema) });
export type InstanceResponse = z.infer<typeof instanceResponseSchema>;
