import { z } from 'zod';

// Domain enums shared by server and client (docs/03 §3.2). Values match the Postgres enums of
// docs/04 §4.1 and travel as UPPER_SNAKE strings (docs/07 §7.4).
export const userRoleSchema = z.enum(['ADMIN', 'USER']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const languageSchema = z.enum(['EN', 'RU']);
export type Language = z.infer<typeof languageSchema>;

export const themeSchema = z.enum(['SYSTEM', 'LIGHT', 'DARK']);
export type Theme = z.infer<typeof themeSchema>;

export const libraryVisibilitySchema = z.enum(['ALL_USERS', 'RESTRICTED']);
export type LibraryVisibility = z.infer<typeof libraryVisibilitySchema>;

export const fileRefStatusSchema = z.enum(['DISCOVERED', 'HASHED', 'MISSING']);
export type FileRefStatus = z.infer<typeof fileRefStatusSchema>;

// Where a document's bytes live and where they came from (docs/03 §3.3.10): a file in a read-only
// library, a scan-set merge, or a file a person sent from their browser. The last two are ours — they
// sit in S3 — which is why so much of the product treats them alike.
// Why a step is SKIPPED (docs/03 §3.3.10). "Skipped" on its own reads like a failure; these say
// which of the harmless reasons it was, and which of them an operator can act on.
export const stepSkipReasonSchema = z.enum([
  'NOT_NEEDED',
  'UNSUPPORTED_FORMAT',
  'NOT_CONFIGURED',
  'NO_CATEGORIES',
  'NO_TEXT',
  'MANUAL_CATEGORY',
]);
export type StepSkipReason = z.infer<typeof stepSkipReasonSchema>;

export const documentSourceSchema = z.enum(['LIBRARY', 'DERIVED', 'UPLOAD']);
export type DocumentSource = z.infer<typeof documentSourceSchema>;

export const stepStatusSchema = z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const categorySourceSchema = z.enum(['NONE', 'AUTO', 'MANUAL']);
export type CategorySource = z.infer<typeof categorySourceSchema>;

export const scanSetStatusSchema = z.enum(['DRAFT', 'QUEUED', 'PROCESSING', 'DONE', 'FAILED']);
export type ScanSetStatus = z.infer<typeof scanSetStatusSchema>;

export const scanRunStatusSchema = z.enum(['RUNNING', 'DONE', 'FAILED']);
export type ScanRunStatus = z.infer<typeof scanRunStatusSchema>;

export const scanSetCropModeSchema = z.enum(['TRIM', 'NONE']);
export type ScanSetCropMode = z.infer<typeof scanSetCropModeSchema>;
