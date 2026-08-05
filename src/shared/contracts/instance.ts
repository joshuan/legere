import { z } from 'zod';

// The admin's read-only view of what this server resolved its configuration to (docs/07 §7.3,
// docs/11 §11.13a).

// Where a value came from — or, for a secret, the fact that there is one. 🔒 A secret never travels
// as a value: `SET` says one is configured and says nothing else about it.
export const settingSourceSchema = z.enum(['ENV', 'DEFAULT', 'SET', 'UNSET']);
export type SettingSource = z.infer<typeof settingSourceSchema>;

export const instanceSettingSchema = z.object({
  key: z.string(),
  // Absent for a secret, and for anything nobody configured.
  value: z.string().nullable(),
  source: settingSourceSchema,
  // What its absence costs, where that is worth saying: "the step is skipped".
  consequence: z.string().nullable(),
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
