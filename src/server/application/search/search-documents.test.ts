import { beforeEach, describe, expect, it } from 'vitest';
import { documentFixture, FakeEmbeddingProvider } from '../../../../test/helpers/processing-fakes';
import {
  DocumentRepository,
  type SearchMatch,
} from '../../domain/repositories/document.repository';
import { SearchDocuments } from './search-documents';

const VIEWER = { id: 'user-1', role: 'USER' } as const;

function match(id: string, rank: number, snippet: string | null): SearchMatch {
  return {
    item: {
      document: { ...documentFixture(), id, title: `Document ${id}` },
      documentType: null,
      availability: 'AVAILABLE',
    },
    rank,
    snippet,
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
  findReadableById() {
    return notUsed();
  }
  updateMeta() {
    return notUsed();
  }
  softDelete() {
    return notUsed();
  }
  filterExistingIds() {
    return notUsed();
  }
  findActiveByContentHash() {
    return notUsed();
  }
  findOrCreateByContentHash() {
    return notUsed();
  }
}

function notUsed(): never {
  throw new Error('not part of searching');
}

const query = {
  q: 'invoice',
  mode: 'hybrid' as const,
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
});
