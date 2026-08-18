import {
  SEARCH_MATCH_FIELDS,
  type SearchMatchField,
  type SearchQuery,
  type SearchResponse,
} from '../../../shared/contracts/search';
import type {
  DocumentRepository,
  SearchFilters,
  SearchMatch,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import { toListDto } from '../documents/manage-documents';

// Reciprocal Rank Fusion (docs/07 §7.3). The constant dampens the top ranks so one engine's
// first place cannot dominate the other's first two — 60 is the value the RRF paper uses and the
// spec fixes.
const RRF_K = 60;

// GET /api/search (docs/07 §7.3): words, meaning, or both.
export class SearchDocuments {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async execute(viewer: Viewer, query: SearchQuery): Promise<SearchResponse> {
    const semanticAvailable = this.embeddings.isConfigured;
    const q = query.q.trim();
    if (q === '') return { items: [], semanticAvailable };

    const filters: SearchFilters = {
      ...(query.libraryId === undefined ? {} : { libraryId: query.libraryId }),
      ...(query.typeId === undefined ? {} : { typeId: query.typeId }),
    };

    // Hybrid without a provider is text: a mode that would silently return nothing is worse than
    // one that quietly does the possible half (docs/05 §5.5 step 5).
    const wantsSemantic = query.mode !== 'text' && semanticAvailable;
    const wantsText = query.mode !== 'semantic' || !semanticAvailable;

    const [text, semantic] = await Promise.all([
      wantsText ? this.documents.searchByText(viewer, q, filters, query.limit) : [],
      wantsSemantic ? this.semantic(viewer, q, filters, query.limit) : [],
    ]);

    const fused = fuse(text, semantic);
    return {
      items: fused.slice(0, query.limit).map((hit) => ({
        document: toListDto(hit.item),
        score: hit.score,
        snippet: hit.snippet,
        matchedIn: hit.matchedIn,
      })),
      semanticAvailable,
    };
  }

  private async semantic(
    viewer: Viewer,
    q: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<SearchMatch[]> {
    const [embedding] = await this.embeddings.embed([q]);
    if (embedding === undefined) return [];
    return this.documents.searchByVector(viewer, embedding, filters, limit);
  }
}

type FusedHit = {
  item: SearchMatch['item'];
  score: number;
  snippet: string | null;
  matchedIn: SearchMatchField[];
};

// Two orderings with no common scale are merged by position, not by score (docs/07 §7.3). Ties break
// on the document id, so the same query always answers in the same order.
//
// A document both halves found keeps both halves' reasons (docs/11 §11.6): "the words are in its
// file name, and it is about this too" is one honest sentence, and dropping either half of it would
// make a fused hit look like whichever engine happened to reach it first.
function fuse(text: readonly SearchMatch[], semantic: readonly SearchMatch[]): FusedHit[] {
  const scores = new Map<string, FusedHit>();

  for (const list of [text, semantic]) {
    for (const match of list) {
      const id = match.item.document.id;
      const contribution = 1 / (RRF_K + match.rank);
      const existing = scores.get(id);

      if (existing === undefined) {
        scores.set(id, {
          item: match.item,
          score: contribution,
          snippet: match.snippet,
          matchedIn: ordered(match.matchedIn),
        });
        continue;
      }
      existing.score += contribution;
      // A text snippet carries the highlight, so it wins over a chunk excerpt when both exist.
      if (existing.snippet === null) existing.snippet = match.snippet;
      existing.matchedIn = ordered([...existing.matchedIn, ...match.matchedIn]);
    }
  }

  return [...scores.values()].sort(
    (a, b) => b.score - a.score || a.item.document.id.localeCompare(b.item.document.id),
  );
}

// One reason each, always in the same order, whichever engine said it (docs/07 §7.3).
function ordered(fields: readonly SearchMatchField[]): SearchMatchField[] {
  return SEARCH_MATCH_FIELDS.filter((field) => fields.includes(field));
}
