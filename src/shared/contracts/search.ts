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

export const searchHitSchema = z.object({
  document: documentListDtoSchema,
  // Rank within this result set, not a similarity: hybrid fuses two orderings that have no common
  // scale (docs/07 §7.3, RRF).
  score: z.number(),
  // Text mode marks the matched words with <mark>; nothing else is ever HTML.
  snippet: z.string().nullable(),
});
export type SearchHitDto = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  items: z.array(searchHitSchema),
  // False when no embedding provider is configured: the UI disables the semantic toggle rather than
  // offering a mode that would silently return nothing.
  semanticAvailable: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
