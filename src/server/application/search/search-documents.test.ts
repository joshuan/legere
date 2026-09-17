import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFixture, FakeEmbeddingProvider } from '../../../../test/helpers/processing-fakes';
import {
  DocumentRepository,
  type DocumentGroupCount,
  type SearchMatch,
} from '../../domain/repositories/document.repository';
import { SearchDocuments } from './search-documents';

const VIEWER = { id: 'user-1', role: 'USER' } as const;

function match(
  id: string,
  rank: number,
  snippet: string | null,
  // Why the engine says it found this one (docs/07 §7.3); the text half's default reason.
  matchedIn: SearchMatch['matchedIn'] = ['text'],
): SearchMatch {
  return {
    item: {
      document: { ...documentFixture(), id, title: `Document ${id}` },
      documentType: null,
      // What a list row derives from the files a document holds (docs/07 §7.3).
      fileCount: 1,
      primaryExt: 'pdf',
      sizeBytes: 1024n,
      origin: 'LIBRARY',
      availability: 'AVAILABLE',
      people: [],
      subjects: [],
    },
    rank,
    snippet,
    matchedIn,
  };
}

// Only the two search methods matter here; the rest of the repository is not part of searching.
class StubSearchRepository extends DocumentRepository {
  text: SearchMatch[] = [];
  vector: SearchMatch[] = [];
  readonly calls: string[] = [];

  searchByText(): Promise<SearchMatch[]> {
    this.calls.push('text');
    return Promise.resolve(this.text);
  }

  searchByVector(): Promise<SearchMatch[]> {
    this.calls.push('vector');
    return Promise.resolve(this.vector);
  }

  findById() {
    return notUsed();
  }
  updateProcessing() {
    return notUsed();
  }
  listYears(): Promise<Array<{ year: number; count: number }>> {
    throw new Error('listYears is not part of search');
  }

  countByGroup(): Promise<DocumentGroupCount[]> {
    throw new Error('countByGroup is not part of search');
  }

  listStaleUnstartedIds(): Promise<[]> {
    return Promise.resolve([]);
  }

  markUnstartedQueued(): Promise<void> {
    return Promise.resolve();
  }

  listIdsByStepStatus(): Promise<string[]> {
    return Promise.resolve([]);
  }

  listReadableItems() {
    return notUsed();
  }

  countByStepStatus() {
    return notUsed();
  }
  listReadable() {
    return notUsed();
  }
  listInFolder() {
    return notUsed();
  }
  listInCollection() {
    return notUsed();
  }
  countReadableInCollections() {
    return notUsed();
  }
  findReadableById() {
    return notUsed();
  }
  updateMeta() {
    return notUsed();
  }
  softDelete() {
    return notUsed();
  }
  hardDelete() {
    return notUsed();
  }
  filterExistingIds() {
    return notUsed();
  }
  create() {
    return notUsed();
  }
}

function notUsed(): never {
  throw new Error('not part of searching');
}

const query = {
  q: 'invoice',
  mode: 'hybrid' as const,
  sort: 'relevance' as const,
  limit: 10,
};

describe('SearchDocuments', () => {
  let documents: StubSearchRepository;
  let embeddings: FakeEmbeddingProvider;
  let search: SearchDocuments;

  beforeEach(() => {
    documents = new StubSearchRepository();
    embeddings = new FakeEmbeddingProvider();
    search = new SearchDocuments(documents, embeddings);
  });

  it('asks neither engine for an empty query', async () => {
    const result = await search.execute(VIEWER, { ...query, q: '   ' });

    expect(result.items).toEqual([]);
    expect(documents.calls).toEqual([]);
  });

  it('merges the two orderings by rank rather than by score', async () => {
    // A document ranked second by both engines beats one ranked first by only one of them.
    documents.text = [match('only-text', 1, 'from text'), match('both', 2, 'both from text')];
    documents.vector = [match('only-vector', 1, 'from chunk'), match('both', 2, 'both from chunk')];

    const result = await search.execute(VIEWER, query);

    expect(result.items.map((hit) => hit.document.id)).toEqual([
      'both',
      'only-text',
      'only-vector',
    ]);
    // A text snippet carries the highlight, so it wins over a chunk excerpt.
    expect(result.items[0]?.snippet).toBe('both from text');
  });

  // Why a row is here survives the fusion (docs/07 §7.3, docs/11 §11.6): a document both engines
  // reached matched the words *and* the meaning, and saying only one of those would make a fused hit
  // look like whichever engine happened to reach it first.
  it("keeps both halves' reasons, in one fixed order", async () => {
    documents.text = [match('both', 1, 'from text', ['fileName', 'title'])];
    documents.vector = [match('both', 1, 'from chunk', ['meaning'])];

    const result = await search.execute(VIEWER, query);

    expect(result.items[0]?.matchedIn).toEqual(['title', 'fileName', 'meaning']);
  });

  it('says of a semantic-only hit that it matched the meaning and nothing else', async () => {
    documents.vector = [match('only-vector', 1, 'from chunk', ['meaning'])];

    const result = await search.execute(VIEWER, query);

    expect(result.items[0]?.matchedIn).toEqual(['meaning']);
  });

  it('answers the same order for the same input', async () => {
    documents.text = [match('a', 1, null), match('b', 2, null)];
    documents.vector = [match('b', 1, null), match('a', 2, null)];

    const first = await search.execute(VIEWER, query);
    const second = await search.execute(VIEWER, query);

    // Equal scores break on the id, so the answer never depends on map iteration order.
    expect(first.items.map((hit) => hit.document.id)).toEqual(
      second.items.map((hit) => hit.document.id),
    );
  });

  it('uses only the text engine when asked for text mode', async () => {
    documents.text = [match('a', 1, null)];

    await search.execute(VIEWER, { ...query, mode: 'text' });

    expect(documents.calls).toEqual(['text']);
  });

  it('embeds the query once for semantic mode', async () => {
    documents.vector = [match('a', 1, 'chunk')];

    const result = await search.execute(VIEWER, { ...query, mode: 'semantic' });

    expect(documents.calls).toEqual(['vector']);
    expect(embeddings.batches).toEqual([['invoice']]);
    expect(result.items.map((hit) => hit.document.id)).toEqual(['a']);
  });

  describe('with no embedding provider configured', () => {
    beforeEach(() => {
      embeddings.configured = false;
    });

    it('reports semantic search as unavailable', async () => {
      const result = await search.execute(VIEWER, query);

      expect(result.semanticAvailable).toBe(false);
    });

    it('answers a hybrid query with text alone', async () => {
      documents.text = [match('a', 1, 'from text')];

      const result = await search.execute(VIEWER, query);

      expect(documents.calls).toEqual(['text']);
      expect(result.items.map((hit) => hit.document.id)).toEqual(['a']);
    });

    it('answers even an explicit semantic query, rather than returning nothing', async () => {
      documents.text = [match('a', 1, 'from text')];

      const result = await search.execute(VIEWER, { ...query, mode: 'semantic' });

      // Silently empty results would read as "no such document" — which is not what happened.
      expect(documents.calls).toEqual(['text']);
      expect(result.items).toHaveLength(1);
    });
  });

  it('limits the fused list, not just each engine', async () => {
    documents.text = [match('a', 1, null), match('b', 2, null)];
    documents.vector = [match('c', 1, null), match('d', 2, null)];

    const result = await search.execute(VIEWER, { ...query, limit: 3 });

    expect(result.items).toHaveLength(3);
  });
  it.each(['hybrid', 'semantic'] as const)(
    'falls back to text when %s embeddings fail',
    async (mode) => {
      documents.text = [match('text-result', 1, 'words')];
      vi.spyOn(embeddings, 'embed').mockRejectedValue(new Error('provider unavailable'));
      const result = await search.execute(VIEWER, { ...query, mode });
      expect(result.items.map((hit) => hit.document.id)).toEqual(['text-result']);
      expect(result.semanticAvailable).toBe(true);
      expect(result.semanticFallback).toBe(true);
      expect(documents.calls).toEqual(['text']);
    },
  );

  it.each(['documentDateAsc', 'documentDateDesc'] as const)(
    'sorts fused results by %s before limiting, with missing dates last',
    async (sort) => {
      const old = match('old', 1, null);
      old.item.document.documentDate = '2020-01-01';
      const recent = match('recent', 2, null);
      recent.item.document.documentDate = '2025-01-01';
      documents.text = [match('undated', 1, null), old];
      documents.vector = [recent];
      const result = await search.execute(VIEWER, { ...query, sort, limit: 2 });
      expect(result.items.map((hit) => hit.document.id)).toEqual(
        sort === 'documentDateAsc' ? ['old', 'recent'] : ['recent', 'old'],
      );
    },
  );

  it('requests ordered text results and a wider semantic pool in the current model', async () => {
    const text = vi.spyOn(documents, 'searchByText');
    const vector = vi.spyOn(documents, 'searchByVector');
    await search.execute(VIEWER, { ...query, sort: 'documentDateDesc' });
    expect(text).toHaveBeenCalledWith(VIEWER, 'invoice', {}, 10, 'documentDateDesc');
    expect(vector).toHaveBeenCalledWith(
      VIEWER,
      expect.any(Array),
      { embeddingModel: embeddings.model },
      200,
    );
  });

  it.each(['titleAsc', 'titleDesc', 'createdAtAsc', 'createdAtDesc'] as const)(
    'orders results by %s',
    async (sort) => {
      const a = match('a', 2, null);
      a.item.document.createdAt = new Date('2020-01-01');
      const b = match('b', 1, null);
      b.item.document.createdAt = new Date('2025-01-01');
      documents.text = [b, a];
      const result = await search.execute(VIEWER, { ...query, sort, mode: 'text' });
      expect(result.items.map((hit) => hit.document.id)).toEqual(
        sort.endsWith('Asc') ? ['a', 'b'] : ['b', 'a'],
      );
    },
  );
});
