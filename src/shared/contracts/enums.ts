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

// Why a step is SKIPPED (docs/03 §3.3.10). "Skipped" on its own reads like a failure; these say
// which of the harmless reasons it was, and which of them an operator can act on.
export const stepSkipReasonSchema = z.enum([
  'NOT_NEEDED',
  'UNSUPPORTED_FORMAT',
  'NOT_CONFIGURED',
  'NO_TYPES',
  'NO_TEXT',
  'MANUAL_TYPE',
  // Longer than an instance lets the pipeline analyse on its own (docs/05 §5.5 step 4). Not a
  // refusal: a person may ask for this one document, and then the whole of it goes.
  'TOO_MANY_PAGES',
]);
export type StepSkipReason = z.infer<typeof stepSkipReasonSchema>;

// Where a file's bytes live (docs/03 §3.3.16): on the read-only volume, or in our own bucket. A
// document has no origin of its own — it is derived from the files it holds, because a document that
// absorbs an upload does not change kind.
export const fileOriginSchema = z.enum(['LIBRARY', 'MANAGED']);
export type FileOrigin = z.infer<typeof fileOriginSchema>;

// Where a step is (docs/03 §3.3.10). `PENDING` and `QUEUED` are the two halves of what used to be
// one word, and telling them apart is the whole point: `QUEUED` says a job exists and a worker will
// get to it; `PENDING` says nothing is scheduled — the artifact is out of date and waits for the
// hourly sweep or for somebody to ask. A migration that resets a step produces the second, and for
// two hours the archive read as busy while nothing at all was going to happen.
export const stepStatusSchema = z.enum([
  'PENDING',
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'SKIPPED',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

// What can happen to a document, in the order a person would tell it (docs/03 §3.3.18).
export const documentEventTypeSchema = z.enum([
  'CREATED',
  'FILE_ATTACHED',
  'FILE_MISSING',
  'QUEUED',
  'STEP_STARTED',
  'STEP_FINISHED',
  'META_CHANGED',
]);
export type DocumentEventType = z.infer<typeof documentEventTypeSchema>;

// Who decided a value: nobody, the pipeline, or a person. One vocabulary for the title and the
// document type, because it is one question (docs/03 §3.3.10).
export const valueSourceSchema = z.enum(['NONE', 'AUTO', 'MANUAL']);
export type ValueSource = z.infer<typeof valueSourceSchema>;

// What shape the pages of the canonical PDF take (docs/05 §5.5 step 1). `AUTO` reads the shape off
// the files themselves; the other two are a person overruling that reading.
export const pageFormatSchema = z.enum(['AUTO', 'A4', 'MATCH_SOURCE']);
export type PageFormat = z.infer<typeof pageFormatSchema>;

export const scanRunStatusSchema = z.enum(['RUNNING', 'DONE', 'FAILED']);
export type ScanRunStatus = z.infer<typeof scanRunStatusSchema>;
