import { z } from 'zod';
import { documentListDtoSchema } from './documents';

// Search contracts (docs/07 §7.3).

// Hybrid is the default: it degrades to text on its own when no embedding provider is configured,
// so a user never has to know which modes an instance actually has (docs/05 §5.5 step 5).
export const searchModeSchema = z.enum(['hybrid', 'text', 'semantic']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().max(500).default(''),
  mode: searchModeSchema.default('hybrid'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  libraryId: z.string().uuid().optional(),
  typeId: z.string().uuid().optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// Why a row is here (docs/07 §7.3, docs/11 §11.6). The text half answers with the parts of the
// document the words were found in — its own columns and the names of what it is made of and about —
// and the semantic half with `meaning`, which is the only thing it can honestly claim. A search that
// never says what it looked at teaches people that the archive does not hold what they asked for.
export const searchMatchFieldSchema = z.enum([
  'title',
  'fileName',
  'person',
  'subject',
  'fields',
  'description',
  'place',
  'text',
  'meaning',
]);
export type SearchMatchField = z.infer<typeof searchMatchFieldSchema>;

// The order reasons are said in, whichever engine found them: the name of the thing first, the prose
// last. Fixed here so one query always reads the same way.
export const SEARCH_MATCH_FIELDS = searchMatchFieldSchema.options;

export const searchHitSchema = z.object({
  document: documentListDtoSchema,
  // Rank within this result set, not a similarity: hybrid fuses two orderings that have no common
  // scale (docs/07 §7.3, RRF).
  score: z.number(),
  // Text mode marks the matched words with <mark>; nothing else is ever HTML.
  snippet: z.string().nullable(),
  // What matched, in `SEARCH_MATCH_FIELDS` order; a fused hit carries both halves' reasons. Empty
  // only where an engine could not say — never a lie about having looked.
  matchedIn: z.array(searchMatchFieldSchema),
});
export type SearchHitDto = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  items: z.array(searchHitSchema),
  // False when no embedding provider is configured: the UI disables the semantic toggle rather than
  // offering a mode that would silently return nothing.
  semanticAvailable: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
