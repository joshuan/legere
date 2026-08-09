import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryDocumentRepository } from '../../../../test/helpers/processing-fakes';
import { MAX_DOCUMENT_GROUPS } from '../../../shared/contracts/documents';
import type { Viewer } from '../../domain/repositories/document.repository';
import { ListDocumentGroups } from './manage-documents';

const VIEWER: Viewer = { id: '11111111-1111-4111-8111-111111111111', role: 'USER' };

// The shelves of one dimension, in the order and the number they are answered in (docs/07 §7.3).
// The counting itself is the repository's, and is proven against a real database; what is decided
// here is which shelves make it into the answer at all.
describe('ListDocumentGroups', () => {
  let documents: InMemoryDocumentRepository;
  let groups: ListDocumentGroups;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    groups = new ListDocumentGroups(documents);
  });

  it('puts the fullest shelf first, and breaks a tie by the label', async () => {
    documents.groups = [
      { key: 'b', label: 'Bar', count: 2 },
      { key: 'z', label: 'Zabljak', count: 9 },
      { key: 'a', label: 'Ada', count: 2 },
    ];

    const answer = await groups.execute(VIEWER, { by: 'city' });

    // Biggest first, because that is where the archive actually is; the label decides a tie so two
    // runs of the same question answer in the same order.
    expect(answer.items.map((item) => item.label)).toEqual(['Zabljak', 'Ada', 'Bar']);
  });

  it('answers a bounded number of shelves, however many the dimension has', async () => {
    documents.groups = Array.from({ length: MAX_DOCUMENT_GROUPS + 40 }, (_, index) => ({
      key: `person-${index}`,
      label: `Person ${index}`,
      count: index,
    }));

    const answer = await groups.execute(VIEWER, { by: 'person' });

    // A person or a city is an unbounded dimension, and an unbounded aggregate on a request any
    // signed-in caller can repeat is not something to serve (docs/07 §7.1).
    expect(answer.items).toHaveLength(MAX_DOCUMENT_GROUPS);
    // What is cut is the emptiest end of it, never the fullest.
    expect(answer.items[0]?.count).toBe(MAX_DOCUMENT_GROUPS + 39);
  });

  it('hands the repository the filters it was given, and the dimension separately', async () => {
    documents.groups = [];

    await groups.execute(VIEWER, { by: 'person', city: 'Podgorica', processing: false });

    // The dimension is the question, not a filter: counting `by=person` must not narrow anything.
    expect(documents.asked?.by).toBe('person');
    expect(documents.asked?.filters).toEqual({ city: 'Podgorica', processing: false });
    expect(documents.asked?.viewer).toBe(VIEWER);
  });
});
