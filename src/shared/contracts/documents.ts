import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import { extractedFieldsSchema, extractedSummarySchema } from './document-fields';
import {
  valueSourceSchema,
  documentEventTypeSchema,
  pageFormatSchema,
  fileOriginSchema,
  fileRefStatusSchema,
  stepSkipReasonSchema,
  stepStatusSchema,
} from './enums';

// Document contracts (docs/07 §7.3).

// The six steps of docs/05 §5.5, named the way the API and the UI refer to them.
export const documentStepSchema = z.enum([
  'canonical',
  'preview',
  'markdown',
  'analysis',
  'fields',
  'vectorization',
]);
export type DocumentStep = z.infer<typeof documentStepSchema>;

export const DOCUMENT_STEPS: readonly DocumentStep[] = documentStepSchema.options;

// Derived, never stored (docs/03 §3.3.10): a LIBRARY document is available while at least one of its
// files is still on a mounted volume.
// Whether the originals behind a document can be read right now (docs/03 §3.3.10). PARTIAL is the
// honest middle: some files of it are on a volume nobody can reach, and the rest are here.
// The canonical PDF reads either way.
export const availabilitySchema = z.enum(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']);
export type Availability = z.infer<typeof availabilitySchema>;

export const documentCategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});

// A name the document carries, with the row it came from: a person or a subject as a card says it
// (docs/03 §3.3.19–3.3.20). The id travels because it is also the key of the shelf that name makes
// (§7.3 grouping) — the name alone would not lead anywhere.
export const documentNameSchema = z.object({ id: z.string().uuid(), name: z.string() });
export type DocumentName = z.infer<typeof documentNameSchema>;

export const documentListDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  // How many files the document is made of, and what they weigh together (docs/07 §7.3).
  fileCount: z.number().int().positive(),
  // The extension of the first file: what the card puts on its badge. Empty when it has none.
  primaryExt: z.string(),
  sizeBytes: z.string(),
  // Pages of the canonical PDF; null until it has been built.
  pageCount: z.number().int().nullable(),
  documentType: documentCategorySchema.nullable(),
  availability: availabilitySchema,
  processing: z.boolean(),
  // LIBRARY when any file of it sits on a volume, MANAGED otherwise (docs/03 §3.3.10).
  origin: fileOriginSchema,
  hasPreview: z.boolean(),
  createdAt: z.string().datetime(),

  // --- what a card may show besides its title (docs/11 §11.3) ----------------------------------
  //
  // Carried for every row of every page, whether or not the screen asked for it: which of them a
  // card draws is the reader's choice and lives in their URL, not in the request. They are read for
  // a whole page in two batched queries — the people and the subjects of `document_id IN (…)` — and
  // never one query per card (docs/04 §4.4).
  //
  // The date on the document, yyyy-mm-dd. Null when it has none, or none was found.
  documentDate: z.string().nullable(),
  // Who and what it is about, in catalogue order. Whether the catalogue still holds a name is the
  // viewer's business rather than a card's (docs/11 §11.5), so `deleted` is on the detail DTO only.
  people: z.array(documentNameSchema),
  subjects: z.array(documentNameSchema),
  // Where it is from: ISO 3166-1 alpha-2, and the city as the document writes it.
  country: z.string().nullable(),
  city: z.string().nullable(),
  // BCP-47 tags, most likely first (docs/03 §3.3.10).
  languages: z.array(z.string()),
  // The summary-flagged typed fields of the document's schema, as stored (docs/03 §3.3.10a);
  // formatted by the client from the registry it ships, keyed off documentType.slug. Null where the
  // type carries no schema or nothing was read.
  extractedSummary: extractedSummarySchema.nullable(),
});
export type DocumentListDto = z.infer<typeof documentListDtoSchema>;

export const documentStepsSchema = z.object({
  canonical: stepStatusSchema,
  preview: stepStatusSchema,
  markdown: stepStatusSchema,
  analysis: stepStatusSchema,
  fields: stepStatusSchema,
  vectorization: stepStatusSchema,
});

// Where a document's bytes live, as far as the caller may know: refs in libraries they cannot see
// are omitted entirely (docs/07 §7.3).
export const documentFileRefSchema = z.object({
  libraryId: z.string().uuid(),
  libraryName: z.string(),
  path: z.string(),
  status: fileRefStatusSchema,
});

// Why a step is SKIPPED, per step; absent for steps that ran (docs/03 §3.3.10).
// A file inside a document (docs/07 §7.3, docs/03 §3.3.16).
export const cropPointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const cropSchema = z.object({
  // Clockwise from the top-left corner, normalized to 0…1 of the image (docs/05 §5.6).
  points: z.tuple([cropPointSchema, cropPointSchema, cropPointSchema, cropPointSchema]),
});
export type Crop = z.infer<typeof cropSchema>;

// 🔒 How many pages one file may be said to have. A page order arrives as an array from a browser,
// and an array with no ceiling is a request that costs whatever the sender felt like; 2000 is past
// any paper an archive holds and short of a payload nobody meant to send. What actually decides a
// valid order is the file's own recorded page count (docs/03 §3.3.16) — this is only the outer
// bound, checked before anything is looked up.
export const MAX_FILE_PAGES = 2000;

// The order the pages of one file are read in (docs/03 §3.3.16): its own 0-based page indices, each
// exactly once. That it is a *permutation* of a particular file's pages cannot be checked here — the
// schema does not know which file — so the shape is checked here and the permutation where the file
// is known (docs/07 §7.3).
export const pageOrderSchema = z.array(z.number().int().nonnegative()).min(1).max(MAX_FILE_PAGES);
export type PageOrder = z.infer<typeof pageOrderSchema>;

// --- which way up the paper lay (docs/03 §3.3.16) ---------------------------------------------

// How a rectangle may be laid down. The mirror is applied first, left to right, and the quarter
// turns clockwise after it; between them the two name all eight orientations, which is why one
// mirror is enough and a second one would only spell an existing turn differently.
export const rotationSchema = z.object({
  quarterTurns: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  mirrored: z.boolean(),
});
export type Rotation = z.infer<typeof rotationSchema>;

// One quarter turn per page of a PDF, in the file's own page order — checked against the recorded
// page count where the file is known, exactly as a page order is (docs/07 §7.3).
export const pageRotationSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type PageRotation = z.infer<typeof pageRotationSchema>;

export const pageRotationsSchema = z.array(pageRotationSchema).min(1).max(MAX_FILE_PAGES);
export type PageRotations = z.infer<typeof pageRotationsSchema>;

// The way the file arrived: nothing turned, nothing mirrored. Stored as `null` rather than as this,
// so "clear the turn" and "never turned" are one value in the database.
export const NO_ROTATION: Rotation = { quarterTurns: 0, mirrored: false };

export function isIdentityRotation(rotation: Rotation | null): boolean {
  return rotation === null || (rotation.quarterTurns === 0 && !rotation.mirrored);
}

// What the editor's three buttons do. Each is a turn applied *after* whatever the file already says,
// which is what makes pressing rotate-right twice a half turn whether or not the page is mirrored:
// a mirror reverses which way "clockwise" runs, so mirroring turns the stored quarter turns round
// rather than leaving them to disagree with the picture.
export type Turn = 'LEFT' | 'RIGHT' | 'MIRROR';

export function turnedRotation(rotation: Rotation | null, turn: Turn): Rotation {
  const current = rotation ?? NO_ROTATION;
  if (turn === 'MIRROR') {
    return {
      quarterTurns: quarterTurnsOf((4 - current.quarterTurns) % 4),
      mirrored: !current.mirrored,
    };
  }
  const step = turn === 'RIGHT' ? 1 : 3;
  return {
    quarterTurns: quarterTurnsOf((current.quarterTurns + step) % 4),
    mirrored: current.mirrored,
  };
}

// The remainder above is 0…3 by construction; this is where the compiler is told so, without a type
// assertion (docs/14 §14.2).
function quarterTurnsOf(value: number): Rotation['quarterTurns'] {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 0;
}

// A point of the unit square through the same turn, for the editor that draws the page turned while
// the crop stays stored against the pixels that arrived (docs/11 §11.5c). The mirror first — x
// reflected — then each quarter turn clockwise, which sends (x, y) to (1 − y, x).
export function turnedPoint(
  point: readonly [number, number],
  rotation: Rotation | null,
): [number, number] {
  const turn = rotation ?? NO_ROTATION;
  let x = turn.mirrored ? 1 - point[0] : point[0];
  let y = point[1];
  for (let step = 0; step < turn.quarterTurns; step += 1) {
    const turnedX = 1 - y;
    y = x;
    x = turnedX;
  }
  return [tidy(x), tidy(y)];
}

// 🔒 A corner turned and turned back is the corner it was. Every step above is `1 − v`, and in
// binary floating point `1 − (1 − 0.1)` is 0.09999999999999998 — so a person who pressed rotate and
// then reset would silently rewrite four numbers nobody touched. A twelfth decimal of a normalized
// coordinate is a millionth of a pixel on the largest scan an archive holds, so rounding there
// costs nothing and makes the two functions exact inverses of one another.
function tidy(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

// And back again: the same turn undone, so what a person dragged onto the page they were looking at
// is stored against the page that arrived.
export function unturnedPoint(
  point: readonly [number, number],
  rotation: Rotation | null,
): [number, number] {
  const turn = rotation ?? NO_ROTATION;
  let x = point[0];
  let y = point[1];
  for (let step = 0; step < turn.quarterTurns; step += 1) {
    const unturnedY = 1 - x;
    x = y;
    y = unturnedY;
  }
  return [tidy(turn.mirrored ? 1 - x : x), tidy(y)];
}

// 🔒 A turn renames the corners as well as moving them, and a crop is a *list* of four corners
// clockwise from the top-left (docs/03 §3.3.16). Turn the page a quarter clockwise and the corner
// that was top-left is the top-right one; leave the list alone and the stored quad would carry a
// second copy of the turn into the build, which applies the crop and then turns again — a quarter
// turn asked for and a half turn delivered. So the two functions below move the points *and*
// re-letter them, which is what makes them exact inverses of one another.
//
// Reflected in a mirror the corners swap in pairs — top-left with top-right, bottom-right with
// bottom-left — which is also what keeps the list wound the way round it was.
const MIRRORED_CORNERS: readonly [number, number, number, number] = [1, 0, 3, 2];

// Which corner of the page that arrived is drawn at this corner of the page on screen.
function sourceCorner(rotation: Rotation | null, screenIndex: number): number {
  const turn = rotation ?? NO_ROTATION;
  const unturned = (screenIndex - turn.quarterTurns + 4) % 4;
  return turn.mirrored ? (MIRRORED_CORNERS[unturned] ?? unturned) : unturned;
}

// And the other way: where on screen this corner of the page that arrived ends up.
function screenCorner(rotation: Rotation | null, sourceIndex: number): number {
  const turn = rotation ?? NO_ROTATION;
  const mirrored = turn.mirrored ? (MIRRORED_CORNERS[sourceIndex] ?? sourceIndex) : sourceIndex;
  return (mirrored + turn.quarterTurns) % 4;
}

// A tuple read at a computed index, without an assertion (docs/14 §14.2).
function cornerAt(points: CropPoints, index: number): readonly [number, number] {
  if (index === 1) return points[1];
  if (index === 2) return points[2];
  if (index === 3) return points[3];
  return points[0];
}

type CropPoints = Crop['points'];

// The whole quadrilateral as the page now stands: what an editor draws over a turned picture.
export function turnedQuad(points: CropPoints, rotation: Rotation | null): CropPoints {
  return [
    turnedPoint(cornerAt(points, sourceCorner(rotation, 0)), rotation),
    turnedPoint(cornerAt(points, sourceCorner(rotation, 1)), rotation),
    turnedPoint(cornerAt(points, sourceCorner(rotation, 2)), rotation),
    turnedPoint(cornerAt(points, sourceCorner(rotation, 3)), rotation),
  ];
}

// And as the file stores it: against the pixels that arrived, clockwise from *their* top-left.
export function unturnedQuad(points: CropPoints, rotation: Rotation | null): CropPoints {
  return [
    unturnedPoint(cornerAt(points, screenCorner(rotation, 0)), rotation),
    unturnedPoint(cornerAt(points, screenCorner(rotation, 1)), rotation),
    unturnedPoint(cornerAt(points, screenCorner(rotation, 2)), rotation),
    unturnedPoint(cornerAt(points, screenCorner(rotation, 3)), rotation),
  ];
}

// A copy of this page that a better one replaced (docs/05 §5.6). It is in the trash, so it is no
// part of the document — but "what did this page look like before" is a question about the page, and
// this is where it is answered. Its bytes download from the document's own file-content route, by
// this id (docs/07 §7.3).
export const documentFileVersionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  ext: z.string(),
  sizeBytes: z.string(),
  origin: fileOriginSchema,
  available: z.boolean(),
  // When it was replaced, which is when it went into the trash.
  trashedAt: z.string().datetime(),
  // The instant the sweep will delete it; null for a library original, which no sweep ever will
  // (docs/05 §5.7a).
  purgeAfter: z.string().datetime().nullable(),
  refs: z.array(documentFileRefSchema),
  storageKey: z.string().nullable(),
});
export type DocumentFileVersionDto = z.infer<typeof documentFileVersionSchema>;

// 🔒 How many entries one document may be asked to hold in one request. The same reasoning as
// `MAX_FILE_PAGES` above, one level out: a whole order arrives as an array from a browser, and an
// array with no ceiling is a request that costs whatever the sender felt like. What decides a valid
// order is the document's own list; this is the outer bound, checked before anything is looked up.
export const MAX_DOCUMENT_PAGES = 2000;

// One page of one document (docs/03 §3.3.17, ADR-025) — the thing the document is an ordered list
// of. The composition endpoints count positions in *this* list, so a caller inserts, cuts and moves
// against exactly what it was last answered with (docs/07 §7.3).
export const documentPageDtoSchema = z.object({
  id: z.string().uuid(),
  // 0-based and contiguous inside one document.
  position: z.number().int().nonnegative(),
  fileId: z.string().uuid(),
  // Which page of that file, by the file's own 0-based index — `null` for the entry standing for a
  // file **whole** while nobody has counted its pages, which is the one place a position covers more
  // than one sheet of paper (docs/03 §3.3.17).
  pageIndex: z.number().int().nonnegative().nullable(),
  // Which way up this page lies and how much of it is paper. `null` is the way it arrived.
  turn: rotationSchema.nullable(),
  crop: cropSchema.nullable(),
  cropSource: valueSourceSchema,
});
export type DocumentPageDto = z.infer<typeof documentPageDtoSchema>;

export const documentFileDtoSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  name: z.string(),
  mimeType: z.string(),
  ext: z.string(),
  sizeBytes: z.string(),
  origin: fileOriginSchema,
  // Whether these bytes can be read right now — false for a library file whose volume lost it.
  available: z.boolean(),
  isImage: z.boolean(),
  crop: cropSchema.nullable(),
  cropSource: valueSourceSchema,
  // Which way up the image lies (docs/03 §3.3.16); null for the way it arrived. Only an image ever
  // carries one, exactly as only an image carries a crop.
  rotation: rotationSchema.nullable(),
  // The pages inside this one file (docs/03 §3.3.16): the order they are read in — null where they
  // stand as they arrived — which way up each of them lies, and how many of them the last canonical
  // build counted, null until one has. Only a PDF ever carries any of the three, and they are what
  // says whether this row has pages worth arranging at all.
  pageOrder: pageOrderSchema.nullable(),
  pageRotations: pageRotationsSchema.nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  // Where the same bytes lie on the volumes the caller can see; empty for a managed file.
  refs: z.array(documentFileRefSchema),
  // The other half of the same question, for the file that has no volume: the key a MANAGED file's
  // bytes lie under in the object storage (docs/09 §9.2). Null for a library file, whose location is
  // its `refs`. Between the two, every file says where it is.
  //
  // 🔒 A location, not a way in: the key names an object in a private bucket and grants nothing
  // without a signed URL, which only an endpoint that has already passed the access check issues.
  // It also says nothing the caller was not already told — the layout is `files/{fileId}/original.{ext}`
  // and both halves are on this very DTO.
  storageKey: z.string().nullable(),
  // The copies of this page that have been replaced, newest first (docs/05 §5.6).
  earlierVersions: z.array(documentFileVersionSchema),
});
export type DocumentFileDto = z.infer<typeof documentFileDtoSchema>;

// Whether this file reads any way up but the one it arrived in — what the **Turned** tag of
// docs/11 §11.5a is drawn from, on the same terms as **Cropped**: present while the stored value
// differs from what arrived, gone the moment it does not. A stored turn of nothing at all is not a
// turn, so a file whose turns were pressed round in a circle stops claiming to be turned.
export function isFileTurned(file: Pick<DocumentFileDto, 'rotation' | 'pageRotations'>): boolean {
  if (!isIdentityRotation(file.rotation)) return true;
  return file.pageRotations !== null && file.pageRotations.some((turn) => turn !== 0);
}

export const documentSkipReasonsSchema = z.record(documentStepSchema, stepSkipReasonSchema);
export type DocumentSkipReasons = z.infer<typeof documentSkipReasonsSchema>;

// What the pipeline worked out, kept beside what the document now says. A person may correct any of
// it; the machine's answer is not thrown away, so the viewer can show "we read X, you made it Y"
// and a wrong correction is never a dead end (docs/03 §3.3.10).
// yyyy-mm-dd, and a real date: 2026-02-31 parses as a string and means nothing.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a calendar date');

// A mark the pipeline gave its own work, out of a hundred (docs/03 §3.3.10). Whole numbers: the
// difference between 87 and 87.4 is not something a model knows about a page it has just read.
export const QUALITY_MARK_MIN = 0;
export const QUALITY_MARK_MAX = 100;
const qualityMarkSchema = z.number().int().min(QUALITY_MARK_MIN).max(QUALITY_MARK_MAX);

// What each reading step thought of itself (docs/03 §3.3.10, docs/05 §5.5 steps 4 and 5).
// `legibility` — how readable the pages themselves are; `extraction` — how faithfully the stored
// text carries what they say, which is `textQuality` counted rather than named; `confidence` — how
// sure the `fields` step is of its whole reading.
//
// 🔒 Every one of them is absent rather than nought where the step did not answer: a missing mark is
// not a zero (docs/03 §3.3.18). And nothing anywhere branches on one — they are recorded, drawn, and
// read by people.
export const documentQualitySchema = z.object({
  legibility: qualityMarkSchema.optional(),
  extraction: qualityMarkSchema.optional(),
  confidence: qualityMarkSchema.optional(),
});
export type DocumentQuality = z.infer<typeof documentQualitySchema>;

// The marks by name, in the order a reader meets them: what the pages were like, what was made of
// them, and how sure the last step is. Written once so the pipeline, the journal and the screen all
// walk the same three.
export const QUALITY_MARKS = ['legibility', 'extraction', 'confidence'] as const;
export type QualityMark = (typeof QUALITY_MARKS)[number];

// One answer read as a mark, wherever it came from. Clamped rather than refused — a model that
// answers 120 has said "as good as it gets", not "unreadable" — and rounded, because a page is not
// read to a tenth of a percent. Anything that is not a number at all is `null`, and 🔒 null is not
// nought: a missing mark means that step does not answer that question (docs/03 §3.3.18). A string
// of digits counts, since providers quote numbers in JSON often enough that refusing "87" would
// throw away a real answer over its punctuation.
export function qualityMarkOf(value: unknown): number | null {
  const answered =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(answered)) return null;
  return Math.min(QUALITY_MARK_MAX, Math.max(QUALITY_MARK_MIN, Math.round(answered)));
}

export const autoValuesSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  date: z.string().optional(),
  // What the analysis read a document to be about, whether or not it became a link.
  subjects: z.array(z.object({ kind: z.string(), name: z.string() })).optional(),
  // Names as the analyst read them, whether or not they became links (docs/03 §3.3.10).
  people: z.array(z.string()).optional(),
  typeSlug: z.string().nullish(),
  languages: z.array(z.string()).optional(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  // How well the stored text represents the document, judged by the analyst against the pages it was
  // shown (docs/05 §5.5 step 4). Absent when it was shown none, and so had nothing to compare.
  textQuality: z.enum(['GOOD', 'PARTIAL', 'NONE']).nullish(),
  // The same judgement counted rather than named, and the fields step's own (docs/03 §3.3.10).
  quality: documentQualitySchema.optional(),
  // The last full answer of the `fields` step, values only (docs/03 §3.3.10a) — what "read as X"
  // and the per-field reset are drawn from.
  fields: z.record(z.unknown()).optional(),
});
export type AutoValues = z.infer<typeof autoValuesSchema>;

export const documentDetailDtoSchema = documentListDtoSchema.extend({
  auto: autoValuesSchema,
  // Who the document is about (docs/03 §3.3.19), in catalogue order. The same list the card gets,
  // plus what only the viewer needs: `deleted` says the catalogue no longer holds this name. The
  // link deliberately survives a deletion, so the only way to tell a name that is still a choice
  // from one that is a record is to be told.
  people: z.array(z.object({ id: z.string().uuid(), name: z.string(), deleted: z.boolean() })),
  // What the document is about (docs/03 §3.3.20); `deleted` as for people above. The kind travels by
  // id as well as by name, because it is a row of its own (§3.3.20a) and a screen showing a subject
  // shows both halves — and each half is a way into the documents filed under it (docs/11 §11.5).
  subjects: z.array(
    z.object({
      id: z.string().uuid(),
      kindId: z.string().uuid(),
      kind: z.string(),
      name: z.string(),
      deleted: z.boolean(),
    }),
  ),
  ocrUsed: z.boolean(),
  // What this document is, in a few hundred characters (docs/03 §3.3.10).
  description: z.string().nullable(),
  pageFormat: pageFormatSchema,
  titleSource: valueSourceSchema,
  typeSource: valueSourceSchema,
  steps: documentStepsSchema,
  skipReasons: documentSkipReasonsSchema,
  // `documentDate`, `languages`, `country` and `city` are the list DTO's own now: a card may show
  // any of them (docs/11 §11.3), so the detail inherits them rather than repeating them.
  processingError: z.string().nullable(),
  failedStep: z.string().nullable(),
  // The document itself, in order (docs/03 §3.3.17): one entry per page, each naming the file it is
  // read from. `files` below is the same list read the other way round — one row per distinct file,
  // everything it says about this document derived from these entries — and this is the one the
  // composition endpoints address, because a position is a place in this list (docs/07 §7.3).
  pages: z.array(documentPageDtoSchema),
  files: z.array(documentFileDtoSchema),
  createdBy: z.object({ id: z.string().uuid(), displayName: z.string() }).nullable(),
  // The whole typed-fields answer (docs/03 §3.3.10a): which schema, the values, and who decided
  // each. Null until the `fields` step first writes it or a person does.
  extracted: extractedFieldsSchema.nullable(),
});
export type DocumentDetailDto = z.infer<typeof documentDetailDtoSchema>;

// Query strings arrive as strings; booleans are spelled out rather than coerced, so `?processing=0`
// cannot silently mean true.
const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

// How a shelf may be arranged (docs/07 §7.1, docs/11 §11.3). A closed set of named orders, not an
// arbitrary sort parameter: each one names a column the schema carries an index for, and a name the
// enum does not hold is a validation failure rather than a slow query.
//
// - `documentDate` — the date written on the paper (docs/03 §3.3.10), newest first, and the undated
//   *before* everything: inside this order a document whose date nobody has read yet is the one
//   still wanting attention, and burying it under a century of dated ones is how it stays unread.
// - `createdAt` — when Legere first saw it. The order every list had before this existed.
// - `lastEventAt` — the newest entry in the document's journal, whatever kind (docs/03 §3.3.18).
//   Deliberately *not* `updatedAt`, which the pipeline bumps whenever it rewrites a step status and
//   which two raw writes skip entirely: it is an honest "row touched" and a dishonest "edited".
export const documentSortSchema = z.enum(['documentDate', 'createdAt', 'lastEventAt']);
export type DocumentSort = z.infer<typeof documentSortSchema>;

export const DOCUMENT_SORTS: readonly DocumentSort[] = documentSortSchema.options;

// The archive as it filled, not as it is kept (docs/07 §7.3): what somebody opening their own
// archive asks is what arrived since they were last here, and the date on the paper cannot answer
// it — a receipt from 2019 scanned this morning is the newest thing here and the oldest thing on the
// shelf. Named here and nowhere else, so no screen and no document has a second opinion about it.
export const DEFAULT_DOCUMENT_SORT: DocumentSort = 'createdAt';

// What narrows a shelf, written once (docs/07 §7.3). The list takes them beside its pagination and
// its order; the grouping endpoint takes exactly the same set beside the dimension it counts by, so
// a group's count is computed under the filters the reader is actually looking through.
export const documentGroupBySchema = z.enum([
  'type',
  'person',
  'subject',
  'year',
  'country',
  'city',
]);
export type DocumentGroupBy = z.infer<typeof documentGroupBySchema>;

export const documentFiltersSchema = z.object({
  libraryId: z.string().uuid().optional(),
  typeId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  // Every subject of one kind at once — "everything about a flat", whichever flat (docs/03 §3.3.20a).
  subjectKindId: z.string().uuid().optional(),
  // The year on the document, not the year it was filed (docs/03 §3.3.10).
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  // Where the document is from. ISO 3166-1 alpha-2, upper-cased on the way in like the PATCH does,
  // so `?country=me` and `?country=ME` are one question; the city is matched exactly as stored,
  // which is what a link carrying a document's own place hands over (docs/07 §7.3).
  country: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
  city: z.string().trim().min(1).max(120).optional(),
  // The documents that have no value in one dimension: the section a grouped grid needs for
  // everything the shelves cannot hold (docs/11 §11.3). Named as a dimension rather than smuggled
  // into the filter above it as a magic value, because "no type" is a different question from "this
  // type" and a uuid column has no room to say it.
  unassigned: documentGroupBySchema.optional(),
  availability: availabilitySchema.optional(),
  processing: queryBoolean,
  origin: fileOriginSchema.optional(),
  // A pipeline step and the status it sits in, given together: what a queue counter links to
  // (docs/07 §7.3, docs/11 §11.13). Either alone is a validation failure — half the question.
  step: documentStepSchema.optional(),
  stepStatus: stepStatusSchema.optional(),
});
export type DocumentFilters = z.infer<typeof documentFiltersSchema>;

export const listDocumentsQuerySchema = paginationQuerySchema
  .merge(documentFiltersSchema)
  .extend({ sort: documentSortSchema.default(DEFAULT_DOCUMENT_SORT) });
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const listDocumentsResponseSchema = paginatedSchema(documentListDtoSchema);

// The years documents carry, newest first, with how many each holds — the folders of a shelf
// arranged by date (docs/07 §7.3).
export const documentYearsResponseSchema = z.object({
  items: z.array(z.object({ year: z.number().int(), count: z.number().int().nonnegative() })),
});
export type DocumentYearsResponse = z.infer<typeof documentYearsResponseSchema>;

// The dimensions a shelf may be grouped by (docs/07 §7.3, docs/11 §11.3).
//
// Every one of them is a filter `GET /api/documents` already takes, and that is not a coincidence:
// a group is only a shelf if its contents can be reached, and what reaches them is the ordinary
// list filtered by the group's own key. Two rules picked this set out of the filters:
//
//  - a group's key must *identify* a shelf, which the four state filters (`availability`,
//    `processing`, `origin`, `step`+`stepStatus`) do not — they say what the machine is doing with a
//    document, not what the document is about, and the filter bar already draws every value of them;
//  - a group's count must be a count of *documents*, which is exact only where the dimension meets a
//    document at most once. `libraryId` and `subjectKindId` are left out for that reason and no
//    other: a document holds many files in one library (and one file may lie at two paths in it),
//    and it may name two subjects of the same kind, so counting either would count joins, not
//    documents. Both remain filters, reachable from the viewer's details pane (docs/11 §11.5).

export const DOCUMENT_GROUP_BY: readonly DocumentGroupBy[] = documentGroupBySchema.options;

// Which filter a group's key belongs in — the link between a shelf and its contents, stated once so
// neither side can invent it (docs/11 §11.3).
export const DOCUMENT_GROUP_FILTER = {
  type: 'typeId',
  person: 'personId',
  subject: 'subjectId',
  year: 'year',
  country: 'country',
  city: 'city',
} as const satisfies Record<DocumentGroupBy, keyof DocumentFilters>;

export const listDocumentGroupsQuerySchema = documentFiltersSchema.extend({
  by: documentGroupBySchema,
});
export type ListDocumentGroupsQuery = z.infer<typeof listDocumentGroupsQuerySchema>;

// One shelf: what to put in the dimension's filter, what to call it, and how many documents are on
// it under the filters in force. A document belonging to several groups — two people, two
// subjects — is counted on each of them, because the alternative is a card missing from a shelf it
// belongs on (docs/07 §7.3).
export const documentGroupSchema = z.object({
  // `null` is the group of documents that have no value in this dimension — no type, no date, nobody
  // named on them. It is not a shelf a person chose to make; it is where everything else is, and
  // without it a grouped grid would not filter those documents out of view but leave them silently
  // absent from it (docs/11 §11.3).
  key: z.string().nullable(),
  label: z.string(),
  count: z.number().int().nonnegative(),
});
export type DocumentGroup = z.infer<typeof documentGroupSchema>;

// An aggregate, not a page of resources: bounded rather than paginated (docs/07 §7.1), in the shape
// `GET /api/documents/years` already answers in.
export const documentGroupsResponseSchema = z.object({ items: z.array(documentGroupSchema) });
export type DocumentGroupsResponse = z.infer<typeof documentGroupsResponseSchema>;

// How many shelves an answer may hold, biggest first. A dimension with more than this is not a
// control anybody can use, and an unbounded aggregate on a request any signed-in caller can repeat
// is not something to serve either (docs/07 §7.3).
export const MAX_DOCUMENT_GROUPS = 100;

// POST /api/documents — an upload (docs/05 §5.1a). `created: false` means the content was already
// here and the caller was allowed to see it, so this is the document it resolved to.
export const uploadDocumentResponseSchema = z.object({
  document: documentListDtoSchema,
  created: z.boolean(),
});
export type UploadDocumentResponse = z.infer<typeof uploadDocumentResponseSchema>;
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

// `typeId: null` clears the documentType; absent leaves it alone (docs/07 §7.4).
// The fields a machine fills in and a person may therefore want back the way it had them.
export const RESETTABLE_FIELDS = [
  'title',
  'description',
  'documentType',
  'languages',
  'country',
  'city',
  'documentDate',
] as const;
export const resettableFieldSchema = z.enum(RESETTABLE_FIELDS);
export type ResettableField = z.infer<typeof resettableFieldSchema>;

// A reset entry: one of the fixed fields above, the whole typed-fields map (`fields`), or one typed
// field (`fields.<key>`) — the key is checked against the document's schema in the use case, where
// the schema is known (docs/07 §7.3).
export const documentResetEntrySchema = z.union([
  resettableFieldSchema,
  z.literal('fields'),
  z
    .string()
    .regex(/^fields\.[A-Za-z][A-Za-z0-9]*$/, 'Expected fields.<key>')
    .max(80),
]);
export type DocumentResetEntry = z.infer<typeof documentResetEntrySchema>;

const MAX_RESET_ENTRIES = 30;
const MAX_FIELDS_PATCH_KEYS = 30;

export const updateDocumentRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    // A paragraph, not an essay: this is read at a glance, and null clears it so the analysis may
    // answer again (docs/03 §3.3.10).
    description: z.string().trim().max(1000).nullable().optional(),
    typeId: z.string().uuid().nullable().optional(),
    // BCP-47, loosely: `ru`, `en`, `sr-Latn`. Kept short so a typo cannot become a novel.
    languages: z.array(z.string().trim().min(2).max(12)).max(5).optional(),
    // ISO 3166-1 alpha-2, upper-cased; null clears it.
    country: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    city: z.string().trim().min(1).max(120).nullable().optional(),
    // The whole set, not a diff: the form sends what the document should end up with. A document
    // rarely names more than a few people, so a cap that low is a typo detector, not a limit.
    peopleIds: z.array(z.string().uuid()).max(20).optional(),
    documentDate: isoDateSchema.nullable().optional(),
    subjectIds: z.array(z.string().uuid()).max(20).optional(),
    // What shape its pages should be. Changing it rebuilds the canonical, because the shape of a
    // page is decided while it is being made (docs/05 §5.5 step 1).
    pageFormat: pageFormatSchema.optional(),
    // A partial edit of the typed fields (docs/03 §3.3.10a): each key set becomes MANUAL, null
    // clears value and source both. Keys and shapes are validated against the document's own schema
    // in the use case, which is where the schema is known.
    fields: z
      .record(z.unknown())
      .refine((value) => Object.keys(value).length > 0, 'At least one field')
      .refine((value) => Object.keys(value).length <= MAX_FIELDS_PATCH_KEYS, 'Too many fields')
      .optional(),
    // Put a field back to what the pipeline read. Not the same as sending that value by hand: a
    // reset documentType becomes AUTO again, so it stops claiming a person chose it (docs/03 §3.3.10).
    reset: z.array(documentResetEntrySchema).min(1).max(MAX_RESET_ENTRIES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

// One entry of a document's history (docs/03 §3.3.18). The payload is deliberately loose: each type
// uses a different few fields, and a log must never fail to render because one entry is odd.
export const documentEventDtoSchema = z.object({
  id: z.string().uuid(),
  type: documentEventTypeSchema,
  at: z.string(),
  // Null is the pipeline acting on its own.
  actor: z.string().nullable(),
  payload: z.object({
    step: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    steps: z.array(z.string()).optional(),
    // Which service did the step, and the id it was asked under — both entries of a started/finished
    // pair carry the same one (docs/03 §3.3.18). The host is an admin's to see.
    service: z.string().optional(),
    endpoint: z.string().optional(),
    requestId: z.string().optional(),
    // What the step cost and what it produced (docs/03 §3.3.18). The pair of entries already
    // brackets the step, and subtracting two timestamps by hand is not a thing a reader should have
    // to do to answer "how long did this take, and did it read anything?".
    durationMs: z.number().optional(),
    chars: z.number().optional(),
    pages: z.number().optional(),
    ocrUsed: z.boolean().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    // Whether the text of this step was read off the pages by a vision model rather than recognised
    // (docs/05 §5.5 step 3).
    transcribed: z.boolean().optional(),
    // What the step made of its own work, out of a hundred (docs/03 §3.3.18): the analysis answers
    // how readable the pages were and how much of them the text carries, the fields step how sure
    // it is of its reading. Absent is "it did not say", exactly like the numbers above.
    legibility: z.number().optional(),
    extraction: z.number().optional(),
    confidence: z.number().optional(),
    source: z.string().optional(),
    library: z.string().optional(),
    path: z.string().optional(),
    // The other end of a link, as a record (docs/03 §3.3.23): the id may point at nothing by the
    // time the log is read, and the title is what still says which paper it was.
    otherDocumentId: z.string().optional(),
    otherTitle: z.string().optional(),
    changes: z
      .record(z.object({ from: z.string().nullish(), to: z.string().nullish() }))
      .optional(),
  }),
});
export type DocumentEventDto = z.infer<typeof documentEventDtoSchema>;

export const documentEventPageSchema = z.object({
  items: z.array(documentEventDtoSchema),
  nextCursor: z.string().nullable(),
});
export type DocumentEventPage = z.infer<typeof documentEventPageSchema>;

// An absent or empty list means the whole pipeline (docs/07 §7.3).
export const reprocessRequestSchema = z.object({
  steps: z.array(documentStepSchema).min(1).max(DOCUMENT_STEPS.length).optional(),
  // Analyse this document however long it is. The page limit is on what the pipeline does *unasked*
  // (`05 §5.5` step 4); this is the asking, and it is per document on purpose — a limit that any
  // bulk re-run could lift would not be a limit.
  analyseInFull: z.boolean().optional(),
});
export type ReprocessRequest = z.infer<typeof reprocessRequestSchema>;

export const reprocessResponseSchema = z.object({
  documentId: z.string().uuid(),
  steps: z.array(documentStepSchema),
});
export type ReprocessResponse = z.infer<typeof reprocessResponseSchema>;

export const documentMarkdownResponseSchema = z.object({ markdown: z.string().nullable() });
export type DocumentMarkdownResponse = z.infer<typeof documentMarkdownResponseSchema>;

// --- document links (docs/03 §3.3.23, docs/07 §7.3) ---------------------------------------------
//
// Undirected: both ends list the same edge. An edge whose other side the caller may not read is
// absent from the answer entirely — not present, not redacted.

export const documentLinkDtoSchema = z.object({
  document: documentListDtoSchema,
  linkedAt: z.string().datetime(),
});
export type DocumentLinkDto = z.infer<typeof documentLinkDtoSchema>;

export const documentLinksResponseSchema = z.object({ items: z.array(documentLinkDtoSchema) });
export type DocumentLinksResponse = z.infer<typeof documentLinksResponseSchema>;

export const createDocumentLinkRequestSchema = z.object({ documentId: z.string().uuid() });
export type CreateDocumentLinkRequest = z.infer<typeof createDocumentLinkRequestSchema>;

// A candidate the archive found by the identifiers the documents share (docs/05 §5.6b), each
// saying which of them matched — "why is this here" is the first question about a suggestion.
export const documentLinkSuggestionSchema = z.object({
  document: documentListDtoSchema,
  matchedTokens: z.array(z.string()),
});
export type DocumentLinkSuggestion = z.infer<typeof documentLinkSuggestionSchema>;

export const documentLinkSuggestionsResponseSchema = z.object({
  items: z.array(documentLinkSuggestionSchema),
});
export type DocumentLinkSuggestionsResponse = z.infer<typeof documentLinkSuggestionsResponseSchema>;
