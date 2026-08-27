import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import { documentListDtoSchema } from './documents';
import { libraryVisibilitySchema, scanRunStatusSchema } from './enums';

// Library contracts (docs/07 §7.3 admin libraries + user-facing list, docs/03 §3.3.6–3.3.8).

// A path relative to LIBRARY_ROOT; '' is the volume root. Traversal is rejected here as well as in
// the domain value object, so a malformed path never reaches the filesystem (docs/05 §5.1).
export const libraryRootPathSchema = z
  .string()
  .max(1024)
  .refine((value) => !value.startsWith('/') && !/^[a-zA-Z]:/.test(value), {
    message: 'Path must be relative to the library root',
  })
  .refine((value) => !value.split(/[/\\]/).some((segment) => segment === '..'), {
    message: 'Path must not traverse upwards',
  });

// 🔒 The count of **pattern characters** is bounded, not just the length. picomatch compiles a glob
// to a backtracking regular expression with no complexity limit of its own, and the matcher runs
// once per directory entry during a scan — so `a*a*a*…b` against a filename of forty `a`s does not
// finish. Measured on the developer's machine: ten `a*` pairs took 195 ms, twelve took 8.2 s,
// fourteen took 86 s, and a scan job has no CPU timeout to stop it.
//
// 🔒 Counting `*` alone was not the bound it read as, which is the correction this carries. The
// quantity that drives the backtracking is how many *variable-length* pieces the pattern has, and
// `*` is only one way to write one. Measured with the repo's own picomatch 4.0.5: `?*?*?*?*?*?*?*?*z`
// has exactly eight `*` and passed, and cost 149 ms against a 34-character name, 2.6 s against 60
// and 21 s against 80; `+(*)x` has **one** `*`, five characters, and compiles to
// `(?:[^/]*?)+x` — 776 ms against 25 `a`s, 6.4 s against 28, 102 s against 32, doubling every two
// characters. So every metacharacter counts against the same allowance, and the extglob and brace
// syntaxes are switched off where the matcher is built (`fs-library-reader.ts`) so that `+(…)` and
// `{…}` are literal characters rather than nested quantifiers. Eight is still far more than any real
// exclusion needs — `**/node_modules/**` uses three.
const MAX_PATTERN_CHARS = 8;

// `*`, `?`, and the openers of the extglob, brace and class syntaxes. `)`, `}` and `]` are not
// counted: they close what an opener already paid for, and counting both halves would halve the
// allowance without bounding anything further.
const PATTERN_CHARS = /[*?+@!({[]/g;

export const excludeGlobsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine((value) => (value.match(PATTERN_CHARS) ?? []).length <= MAX_PATTERN_CHARS, {
        message: `A glob may use at most ${MAX_PATTERN_CHARS} pattern characters`,
      }),
  )
  .max(50);

// Minimum 1 minute, default 15 (docs/03 §3.3.6).
export const scanIntervalMinutesSchema = z.number().int().min(1).max(10_080);

export const createLibraryRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  rootPath: libraryRootPathSchema,
  visibility: libraryVisibilitySchema.default('RESTRICTED'),
  scanIntervalMinutes: scanIntervalMinutesSchema.default(15),
  excludeGlobs: excludeGlobsSchema.default([]),
  userIds: z.array(z.string().uuid()).max(1000).default([]),
});
export type CreateLibraryRequest = z.infer<typeof createLibraryRequestSchema>;

// rootPath is absent on purpose: it is immutable, and a new library is the way to point elsewhere
// (docs/07 §7.3).
export const updateLibraryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    visibility: libraryVisibilitySchema.optional(),
    scanIntervalMinutes: scanIntervalMinutesSchema.optional(),
    excludeGlobs: excludeGlobsSchema.optional(),
    userIds: z.array(z.string().uuid()).max(1000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateLibraryRequest = z.infer<typeof updateLibraryRequestSchema>;

export const libraryAdminDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  rootPath: z.string(),
  enabled: z.boolean(),
  visibility: libraryVisibilitySchema,
  scanIntervalMinutes: z.number().int(),
  excludeGlobs: z.array(z.string()),
  userIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
});
export type LibraryAdminDto = z.infer<typeof libraryAdminDtoSchema>;

export const libraryCountersSchema = z.object({
  files: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});
export type LibraryCounters = z.infer<typeof libraryCountersSchema>;

// The admin table shows the last scan's time and status alongside the counters (docs/11 §11.10).
export const lastScanSchema = z
  .object({
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    status: scanRunStatusSchema,
  })
  .nullable();

export const libraryAdminListItemSchema = libraryAdminDtoSchema.extend({
  counters: libraryCountersSchema,
  lastScan: lastScanSchema,
});
export type LibraryAdminListItem = z.infer<typeof libraryAdminListItemSchema>;

export const listLibrariesAdminResponseSchema = z.object({
  items: z.array(libraryAdminListItemSchema),
});
export type ListLibrariesAdminResponse = z.infer<typeof listLibrariesAdminResponseSchema>;

// GET /api/libraries — what a non-admin caller may see (docs/07 §7.3).
export const libraryDtoSchema = z.object({ id: z.string().uuid(), name: z.string() });
export type LibraryDto = z.infer<typeof libraryDtoSchema>;

export const listLibrariesResponseSchema = z.object({ items: z.array(libraryDtoSchema) });
export type ListLibrariesResponse = z.infer<typeof listLibrariesResponseSchema>;

// GET /api/admin/library-path-candidates?path=
export const pathCandidatesQuerySchema = z.object({
  path: libraryRootPathSchema.default(''),
});
export type PathCandidatesQuery = z.infer<typeof pathCandidatesQuerySchema>;

export const pathCandidatesResponseSchema = z.object({
  path: z.string(),
  dirs: z.array(z.object({ name: z.string() })),
});
export type PathCandidatesResponse = z.infer<typeof pathCandidatesResponseSchema>;

// POST /api/admin/libraries/:id/scan — a no-op while a scan is already running.
export const triggerScanResponseSchema = z.union([
  z.object({ scanRunId: z.string().uuid() }),
  z.object({ alreadyRunning: z.literal(true) }),
]);
export type TriggerScanResponse = z.infer<typeof triggerScanResponseSchema>;

// GET /api/admin/libraries/:id/scans — newest first (docs/07 §7.3).
export const scanRunDtoSchema = z.object({
  id: z.string().uuid(),
  status: scanRunStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  filesSeen: z.number().int(),
  filesNew: z.number().int(),
  filesChanged: z.number().int(),
  filesMissing: z.number().int(),
  error: z.string().nullable(),
});
export type ScanRunDto = z.infer<typeof scanRunDtoSchema>;

export const listScanRunsQuerySchema = paginationQuerySchema;
export type ListScanRunsQuery = z.infer<typeof listScanRunsQuerySchema>;

export const listScanRunsResponseSchema = paginatedSchema(scanRunDtoSchema);
export type ListScanRunsResponse = z.infer<typeof listScanRunsResponseSchema>;

// Browse (docs/07 §7.3, docs/11 §11.4): folders are not stored anywhere — they are derived from the
// paths of the FileRefs a scan recorded, at whatever depth the volume happens to have.
export const browseQuerySchema = paginationQuerySchema.extend({
  path: libraryRootPathSchema.default(''),
});
export type BrowseQuery = z.infer<typeof browseQuerySchema>;

export const browseFolderSchema = z.object({
  name: z.string(),
  // Documents anywhere beneath the folder, so an empty-looking folder is never a dead end.
  documentCount: z.number().int().nonnegative(),
});
export type BrowseFolderDto = z.infer<typeof browseFolderSchema>;

export const browseResponseSchema = z.object({
  path: z.string(),
  folders: z.array(browseFolderSchema),
  documents: paginatedSchema(documentListDtoSchema),
});
export type BrowseResponse = z.infer<typeof browseResponseSchema>;
