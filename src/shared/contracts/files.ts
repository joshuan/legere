import { z } from 'zod';
import {
  cropSchema,
  documentDetailDtoSchema,
  MAX_DOCUMENT_PAGES,
  pageOrderSchema,
  pageRotationsSchema,
  rotationSchema,
} from './documents';

// Composing a document out of pages (docs/07 §7.3 "Document pages and files", docs/05 §5.6). Every
// one of these answers with the whole document: a composition change is never local — and the answer
// carries the page list the caller's next request will index into (docs/03 §3.3.17).

// PATCH /api/documents/:id/files — the complete order, every file of the document exactly once.
export const reorderDocumentFilesRequestSchema = z.object({
  order: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderDocumentFilesRequest = z.infer<typeof reorderDocumentFilesRequestSchema>;

// A place in a document's own list of entries, 0-based (docs/03 §3.3.17). What "between page two and
// page three" is said with, and — while a file is held whole — a place before that file or after it,
// never inside it.
const positionSchema = z.number().int().nonnegative().max(MAX_DOCUMENT_PAGES);

// POST /api/documents/:id/files?at= — where the uploaded file's pages go. Absent is "after the last
// page the document has", which is what an append always was.
export const addDocumentFileQuerySchema = z.object({
  at: z.coerce.number().int().nonnegative().max(MAX_DOCUMENT_PAGES).optional(),
});
export type AddDocumentFileQuery = z.infer<typeof addDocumentFileQuerySchema>;

// PATCH /api/documents/:id/pages — the complete order, every page of the document exactly once. One
// request and one truth: a partial order would leave the rest somewhere nobody chose, and "move this
// page to position 3" is this request with the resulting order in it rather than an endpoint of its
// own, because a whole permutation is the only shape that cannot be half applied (docs/05 §5.6).
export const reorderDocumentPagesRequestSchema = z.object({
  order: z.array(z.string().uuid()).min(1).max(MAX_DOCUMENT_PAGES),
});
export type ReorderDocumentPagesRequest = z.infer<typeof reorderDocumentPagesRequestSchema>;

// 🔒 How many cuts one request may make. A split answers with a document per part, and every part is
// linked to every other (docs/03 §3.3.23) — so the edges grow with the square of this number, and it
// is small on purpose: twenty cuts is more than anybody makes at a page strip in one gesture.
export const MAX_SPLIT_BOUNDARIES = 20;

// POST /api/documents/:id/split — the 0-based page boundaries to cut at: `[8]` puts pages 0…7 in the
// document that is there and 8… in a new one. A cut at 0 or past the last page is refused where the
// list is known, because every part has to be a document and a document has at least one page.
export const splitDocumentRequestSchema = z.object({
  at: z.array(z.number().int().positive().max(MAX_DOCUMENT_PAGES)).min(1).max(MAX_SPLIT_BOUNDARIES),
});
export type SplitDocumentRequest = z.infer<typeof splitDocumentRequestSchema>;

export const splitDocumentResponseSchema = z.object({
  document: documentDetailDtoSchema,
  // The parts that were cut off, in the order the cuts made them.
  splitDocumentIds: z.array(z.string().uuid()).min(1),
});
export type SplitDocumentResponse = z.infer<typeof splitDocumentResponseSchema>;

// POST /api/documents/:id/pages/move — the pages that belong elsewhere go there. `documentId: null`
// is "a new document made to hold them", which has one place to put them and therefore takes no
// position at all (docs/05 §5.6).
export const moveDocumentPagesRequestSchema = z
  .object({
    pageIds: z.array(z.string().uuid()).min(1).max(MAX_DOCUMENT_PAGES),
    documentId: z.string().uuid().nullable(),
    at: positionSchema.optional(),
  })
  .refine((body) => body.documentId !== null || body.at === undefined, {
    message: 'A new document has one place to put them, so it takes no position',
  });
export type MoveDocumentPagesRequest = z.infer<typeof moveDocumentPagesRequestSchema>;

export const moveDocumentPagesResponseSchema = z.object({
  document: documentDetailDtoSchema,
  // Where they went: the document named, or the one that was made for them.
  movedToDocumentId: z.string().uuid(),
});
export type MoveDocumentPagesResponse = z.infer<typeof moveDocumentPagesResponseSchema>;

// PATCH /api/documents/:id/pages/:pageId — how one page lies and how much of it is paper
// (docs/03 §3.3.17). `null` clears either and the page goes back to what arrived; neither is ever a
// change to the bytes.
//
// 🔒 A crop is taken on **any** page — a page of a PDF as much as a photograph — because the build
// honours it on either by rendering the page and warping it (docs/05 §5.5 step 1). A `mirrored`
// turn is a page of an image's own, and asking for it elsewhere is `422 FILE_NOT_IMAGE`: that
// cannot be checked here, where nothing knows which file the page is read from, so the shape is
// checked here and the page where the page is known (docs/07 §7.3).
export const updateDocumentPageRequestSchema = z
  .object({
    crop: cropSchema.nullable().optional(),
    turn: rotationSchema.nullable().optional(),
  })
  .refine((body) => body.crop !== undefined || body.turn !== undefined, {
    message: 'Name at least one of crop or turn',
  });
export type UpdateDocumentPageRequest = z.infer<typeof updateDocumentPageRequestSchema>;

// PATCH /api/documents/:id/files/:fileId — what one file says about **its own pages as a set**: the
// order they are read in and which way up each of them lies, both by the file's own 0-based indices
// (docs/03 §3.3.16). `null` clears either and the file goes back to what arrived — neither is ever a
// change to the bytes.
//
// That is all this route is since ADR-025. A crop and a turn belong to the page that carries them
// and are asked of the route that names it, above: a crop because every page takes one now and a
// file could only ever offer it to an image, a turn because an image is one page and two ways of
// writing one row is how they drift apart (docs/07 §7.3).
//
// Both keys are optional and a body naming none is refused: "change nothing" is not an edit, and a
// PATCH that quietly did nothing would look exactly like one that worked.
export const updateDocumentFileRequestSchema = z
  .object({
    pageOrder: pageOrderSchema.nullable().optional(),
    pageRotations: pageRotationsSchema.nullable().optional(),
  })
  .refine((body) => body.pageOrder !== undefined || body.pageRotations !== undefined, {
    message: 'Name at least one of pageOrder or pageRotations',
  });
export type UpdateDocumentFileRequest = z.infer<typeof updateDocumentFileRequestSchema>;

// GET /api/documents/:id/files/:fileId/crop-suggestion — a proposal, stored only if the client saves
// it. `method` says which answer this is: the page the detector found, or the content bounding box
// it fell back to (docs/05 §5.6).
export const cropSuggestionResponseSchema = z.object({
  crop: cropSchema,
  method: z.enum(['EDGES', 'CONTENT_BOX']),
});
export type CropSuggestionResponse = z.infer<typeof cropSuggestionResponseSchema>;

// DELETE /api/documents/:id/files/:fileId — the file leaves and becomes a document of its own.
export const splitDocumentFileResponseSchema = z.object({
  document: documentDetailDtoSchema,
  splitDocumentId: z.string().uuid(),
});
export type SplitDocumentFileResponse = z.infer<typeof splitDocumentFileResponseSchema>;

// POST /api/documents/:id/combine — the files of those documents, appended in that order.
export const combineDocumentsRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(50),
});
export type CombineDocumentsRequest = z.infer<typeof combineDocumentsRequestSchema>;

// GET /api/documents/grouping-suggestions (docs/05 §5.6a). Computed, never stored.
export const groupingSuggestionSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(2),
  libraryId: z.string().uuid(),
  libraryName: z.string(),
  folder: z.string(),
  // Why these were put together: a run of names, or one sitting at the scanner.
  reason: z.enum(['NAME_SEQUENCE', 'SAME_SITTING']),
});
export type GroupingSuggestion = z.infer<typeof groupingSuggestionSchema>;

export const groupingSuggestionsResponseSchema = z.object({
  items: z.array(groupingSuggestionSchema),
});
export type GroupingSuggestionsResponse = z.infer<typeof groupingSuggestionsResponseSchema>;
