import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentsScreen } from './documents-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

// The screen reads its filters from the URL and writes them back through the router (docs/11 §11.3).
const replace = vi.fn();
const push = vi.fn();
let currentSearch = '';

// Filters that reach this screen as a link from somewhere else (docs/11 §11.5).
const PERSON_ID = 'dddddddd-1111-4111-8111-111111111111';
const KIND_ID = 'dddddddd-3333-4333-8333-333333333333';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => '/documents',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

function documentAt(index: number, overrides: Partial<DocumentListDto> = {}): DocumentListDto {
  return {
    id: `aaaaaaaa-1111-4111-8111-00000000000${index}`,
    title: `Document ${index}`,
    fileCount: 1,
    primaryExt: 'pdf',
    sizeBytes: '2048',
    pageCount: 1,
    documentType: null,
    availability: 'AVAILABLE',
    processing: false,
    origin: 'LIBRARY',
    hasPreview: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    // What a card may show, carried on every row whether or not this reader draws it (docs/07 §7.3).
    documentDate: '2026-02-03',
    people: [{ id: PERSON_ID, name: 'Ana Petrović' }],
    subjects: [],
    country: 'ME',
    city: 'Podgorica',
    languages: ['sr'],
    extractedSummary: null,
    ...overrides,
  };
}

// The one the Upload button hides: choosing files is what the screen does, and where they go from
// there is the queue's business (docs/11 §11.3a).
function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
  return input;
}

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  currentSearch = '';
  server.use(
    http.get('/api/documents', () =>
      HttpResponse.json(envelope({ items: [documentAt(1), documentAt(2)], nextCursor: null })),
    ),
    // Computed on every visit and never stored (docs/05 §5.6a); most instances have nothing to say.
    http.get('/api/documents/grouping-suggestions', () =>
      HttpResponse.json(envelope({ items: [] })),
    ),
    http.get('/api/libraries', () =>
      HttpResponse.json(
        envelope({ items: [{ id: 'cccccccc-3333-4333-8333-333333333333', name: 'Invoices' }] }),
      ),
    ),
    http.get('/api/document-types', () =>
      HttpResponse.json(
        envelope({
          items: [
            {
              id: 'dddddddd-4444-4444-8444-444444444444',
              slug: 'contract',
              name: 'Contract',
              description: null,
              documentCount: 2,
            },
          ],
        }),
      ),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('DocumentsScreen', () => {
  it('shows the grid', async () => {
    renderWithProviders(<DocumentsScreen />);

    expect(await screen.findByText('Document 1')).toBeInTheDocument();
    expect(screen.getByText('Document 2')).toBeInTheDocument();
  });

  it('reads the filters out of the URL and sends them to the API', async () => {
    currentSearch = 'origin=MANAGED&processing=true';
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [documentAt(1)], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    expect(seen[0]).toContain('origin=MANAGED');
    expect(seen[0]).toContain('processing=true');
  });

  it('writes the origin filter back into the URL', async () => {
    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    await userEvent.click(
      screen.getByRole('combobox', { name: enMessages.documents.filters.origin }),
    );
    await userEvent.click(await screen.findByTitle(enMessages.documents.filters.originManaged));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents?origin=MANAGED'));
  });

  it('writes a chosen filter back into the URL, so the view can be linked', async () => {
    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    await userEvent.click(
      screen.getByRole('switch', { name: enMessages.documents.filters.processingOnly }),
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents?processing=true'));
  });

  it('takes a step and its status from the URL, names them and clears them together', async () => {
    // Where a queue counter lands (docs/11 §11.13).
    currentSearch = 'step=preview&stepStatus=FAILED';
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [documentAt(1)], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    expect(seen[0]).toContain('step=preview');
    expect(seen[0]).toContain('stepStatus=FAILED');
    // In words, not in the API's spelling — and named as the counter that was pressed names it.
    expect(screen.getByText('Preview: failed')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(enMessages.documents.filters.stepClear));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
  });

  it('never sends half of the step filter, because the API refuses half a question', async () => {
    currentSearch = 'step=preview';
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText(enMessages.documents.empty.instance);

    // 422 is what half of it would earn (docs/07 §7.3); it is not a filter at all until it is whole.
    expect(seen[0] ?? '').not.toContain('step');
    expect(screen.queryByText(/Preview/)).toBeNull();
  });

  it('keeps the step filter while another one is changed', async () => {
    currentSearch = 'step=preview&stepStatus=FAILED';

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    await userEvent.click(
      screen.getByRole('switch', { name: enMessages.documents.filters.processingOnly }),
    );

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        '/documents?processing=true&step=preview&stepStatus=FAILED',
      ),
    );
  });

  // A name in the viewer's details pane is a link into this screen (docs/11 §11.5), and the filters
  // it carries have no control of their own in the bar. They still have to survive the trip.
  it('takes every filter the contract knows out of the URL, not only the ones the bar draws', async () => {
    currentSearch = `personId=${PERSON_ID}&subjectKindId=${KIND_ID}&country=me&city=Podgorica&year=2019`;
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [documentAt(1)], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    expect(seen[0]).toContain(`personId=${PERSON_ID}`);
    expect(seen[0]).toContain(`subjectKindId=${KIND_ID}`);
    // Upper-cased on the way in by the contract's own schema, so `?country=me` is the same question.
    expect(seen[0]).toContain('country=ME');
    expect(seen[0]).toContain('city=Podgorica');
    expect(seen[0]).toContain('year=2019');
  });

  it('keeps a filter that arrived by link while another one is changed', async () => {
    currentSearch = `subjectKindId=${KIND_ID}`;

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    await userEvent.click(
      screen.getByRole('switch', { name: enMessages.documents.filters.processingOnly }),
    );

    // Dropped by the first switch anybody touched, it would be a link that only half works.
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/documents?subjectKindId=${KIND_ID}&processing=true`),
    );

    // And "Clear filters" still takes it off: it clears what is in force, not what is drawn.
    await userEvent.click(screen.getByRole('button', { name: enMessages.documents.filters.clear }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
  });

  it('ignores a filter value the contract does not know', async () => {
    currentSearch = 'availability=MAYBE';
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText(enMessages.documents.empty.instance);

    // A hand-edited URL cannot smuggle a filter past the contract.
    expect(seen[0] ?? '').not.toContain('availability');
  });

  // Which of a document's own facts the cards draw, chosen here and carried in the URL beside the
  // filters (docs/11 §11.3).
  describe('what the cards show', () => {
    it('draws the extension and the type until it is told otherwise', async () => {
      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      expect(screen.getAllByText('PDF')).toHaveLength(2);
      expect(screen.queryByText('Ana Petrović')).toBeNull();
    });

    it('draws the fields the URL names instead, extension and type included', async () => {
      currentSearch = 'card=people,date';

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      expect(screen.getAllByText('Ana Petrović')).toHaveLength(2);
      expect(screen.getAllByText('2026-02-03')).toHaveLength(2);
      // Both of the old badges are a choice now, and this URL did not choose them.
      expect(screen.queryByText('PDF')).toBeNull();
    });

    it('writes a change to the choice back into the URL, beside the filters', async () => {
      currentSearch = 'processing=true';

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.click(
        screen.getByRole('combobox', { name: enMessages.documents.card.label }),
      );
      await userEvent.click(await screen.findByTitle(enMessages.documents.card.options.people));

      // The filter in force is untouched: arranging a card is not narrowing a shelf.
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith('/documents?processing=true&card=ext%2Ctype%2Cpeople'),
      );
    });

    it('takes an empty choice as "title only" rather than as no choice at all', async () => {
      currentSearch = 'card=';

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      // An empty value is somebody having switched everything off; absence is what means "default".
      expect(screen.queryByText('PDF')).toBeNull();
      expect(screen.queryByText('Ana Petrović')).toBeNull();
      expect(screen.getAllByText('Document 1')).toHaveLength(1);
    });

    it('says nothing in the URL once the choice is the default one again', async () => {
      currentSearch = 'card=ext';

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.click(
        screen.getByRole('combobox', { name: enMessages.documents.card.label }),
      );
      await userEvent.click(await screen.findByTitle(enMessages.documents.card.options.type));

      // Back at what the card has always shown, so it leaves no trace — like an unset filter.
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
    });
  });

  // How the shelf is arranged, and which of the three arrangements needs saying (docs/11 §11.3).
  describe('order', () => {
    function watchList(): string[] {
      const seen: string[] = [];
      server.use(
        http.get('/api/documents', ({ request }) => {
          seen.push(new URL(request.url).search);
          return HttpResponse.json(envelope({ items: [documentAt(1)], nextCursor: null }));
        }),
      );
      return seen;
    }

    it('opens on what arrived last, and says nothing about it in the URL', async () => {
      const seen = watchList();

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      // The archive as it filled, not as it is kept: what somebody arriving asks is what came in
      // since they were last here (docs/07 §7.3).
      expect(seen[0]).toContain('sort=createdAt');
      expect(screen.getByTitle(enMessages.documents.sort.options.createdAt)).toBeInTheDocument();
      // The default leaves no trace in the query string, the way an unset filter does not.
      expect(replace).not.toHaveBeenCalled();
    });

    it('honours a link that names the date on the document', async () => {
      currentSearch = 'sort=documentDate';
      const seen = watchList();

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      expect(seen[0]).toContain('sort=documentDate');
      expect(screen.getByTitle(enMessages.documents.sort.options.documentDate)).toBeInTheDocument();
    });

    it('carries an order that is not the default in the URL, and drops it again at the default', async () => {
      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.click(
        screen.getByRole('combobox', { name: enMessages.documents.sort.label }),
      );
      await userEvent.click(
        await screen.findByTitle(enMessages.documents.sort.options.documentDate),
      );

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents?sort=documentDate'));
    });

    it('says nothing in the URL once the order is the default one again', async () => {
      currentSearch = 'sort=documentDate';

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.click(
        screen.getByRole('combobox', { name: enMessages.documents.sort.label }),
      );
      await userEvent.click(await screen.findByTitle(enMessages.documents.sort.options.createdAt));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents'));
    });

    it('falls back to the default rather than sending on an order the contract does not know', async () => {
      currentSearch = 'sort=title';
      const seen = watchList();

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      // A hand-edited URL earns the shelf it would have had, not a 422 (docs/11 §11.3).
      expect(seen[0]).toContain('sort=createdAt');
      expect(seen[0]).not.toContain('sort=title');
    });
  });

  // Real shelves with real counts, from the server (docs/11 §11.3).
  describe('grouping', () => {
    const GROUPS = [
      { key: PERSON_ID, label: 'Ana Petrović', count: 12 },
      { key: 'dddddddd-2222-4222-8222-222222222222', label: 'Marko Marković', count: 3 },
    ];

    it('asks for no shelves at all until a dimension is chosen', async () => {
      let asked = 0;
      server.use(
        http.get('/api/documents/groups', () => {
          asked += 1;
          return HttpResponse.json(envelope({ items: GROUPS }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      expect(asked).toBe(0);
    });

    it('draws a section per group, with the count the server gave', async () => {
      currentSearch = 'groupBy=person&processing=true';
      const seen: string[] = [];
      server.use(
        http.get('/api/documents/groups', ({ request }) => {
          seen.push(new URL(request.url).search);
          return HttpResponse.json(envelope({ items: GROUPS }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);

      // A heading says what the archive holds under it, not what has been scrolled to; pressing it
      // folds the section and nothing else (docs/11 §11.3).
      expect(await screen.findByText('Ana Petrović · 12')).toBeInTheDocument();
      expect(screen.getByText('Marko Marković · 3')).toBeInTheDocument();
      expect(seen[0]).toContain('by=person');
      expect(seen[0]).toContain('processing=true');
    });

    it('fetches each section under its own key, and the last one under none', async () => {
      currentSearch = 'groupBy=person';
      const asked: string[] = [];
      server.use(
        http.get('/api/documents/groups', () =>
          HttpResponse.json(envelope({ items: [...GROUPS, { key: null, label: '', count: 7 }] })),
        ),
        http.get('/api/documents', ({ request }) => {
          asked.push(new URL(request.url).search);
          return HttpResponse.json(envelope({ items: [], nextCursor: null }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      // 🔒 The group the dimension cannot place has a section of its own: without it those documents
      // would not be filtered out of view but silently absent from it (docs/11 §11.3).
      expect(await screen.findByText('Not filed (7)')).toBeInTheDocument();

      await waitFor(() =>
        expect(asked.some((search) => search.includes(`personId=${PERSON_ID}`))).toBe(true),
      );
      await waitFor(() =>
        expect(asked.some((search) => search.includes('unassigned=person'))).toBe(true),
      );
    });

    it('narrows a section by its group even when the archive is already filtered to it', async () => {
      currentSearch = `groupBy=person&personId=${PERSON_ID}`;
      const asked: string[] = [];
      server.use(
        http.get('/api/documents/groups', () => HttpResponse.json(envelope({ items: GROUPS }))),
        http.get('/api/documents', ({ request }) => {
          asked.push(new URL(request.url).search);
          return HttpResponse.json(envelope({ items: [], nextCursor: null }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Ana Petrović · 12');

      // 🔒 A section is not a press. Asked for the contents of a group the archive is already
      // filtered to, the old toggle removed the filter and drew the whole archive under a heading
      // that counted one group (docs/11 §11.3).
      await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(GROUPS.length));
      // Every section asks for its own group. The one whose key *is* the active filter asks for it
      // too — the toggle used to drop it there and answer with the whole archive.
      expect(asked.some((search) => search.includes(`personId=${PERSON_ID}`))).toBe(true);
      expect(asked.every((search) => search.includes('personId='))).toBe(true);
    });

    it('sets no filter by being looked at', async () => {
      currentSearch = 'groupBy=person';
      server.use(
        http.get('/api/documents/groups', () => HttpResponse.json(envelope({ items: GROUPS }))),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Ana Petrović · 12');

      // Grouping arranges the grid; it does not narrow the archive, so leaving it leaves the
      // archive where it was (docs/11 §11.3).
      expect(replace).not.toHaveBeenCalled();
    });

    it('ignores a dimension the contract does not offer', async () => {
      currentSearch = 'groupBy=library';
      let asked = 0;
      server.use(
        http.get('/api/documents/groups', () => {
          asked += 1;
          return HttpResponse.json(envelope({ items: [] }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      // A hand-edited URL falls back to no grouping rather than earning a 422 (docs/11 §11.3).
      expect(asked).toBe(0);
    });

    // A grouped grid reads as an index and opens where it matters: a heading folds its section, and
    // the fold lasts the tab (docs/11 §11.3).
    describe('folding', () => {
      const UNPLACED = { key: null, label: '', count: 7 };

      // The sections and what each of them asked the list for, so a fold can be shown to cost the
      // server nothing.
      function watchSections(): string[] {
        const asked: string[] = [];
        server.use(
          http.get('/api/documents/groups', () =>
            HttpResponse.json(envelope({ items: [...GROUPS, UNPLACED] })),
          ),
          http.get('/api/documents', ({ request }) => {
            asked.push(new URL(request.url).search);
            return HttpResponse.json(envelope({ items: [documentAt(1)], nextCursor: null }));
          }),
        );
        return asked;
      }

      const heading = (name: string): HTMLElement => screen.getByRole('button', { name });

      // Only what a section asked for. The screen keeps the ungrouped list beside the sections, and
      // that one request is nobody's group.
      const bySection = (asked: readonly string[]): string[] =>
        asked.filter(
          (search) => search.includes('personId=') || search.includes('unassigned=person'),
        );

      beforeEach(() => window.sessionStorage.clear());
      afterEach(() => window.sessionStorage.clear());

      it('folds a section from its heading and unfolds it again, asking for nothing in between', async () => {
        currentSearch = 'groupBy=person';
        const asked = watchSections();

        renderWithProviders(<DocumentsScreen />);
        await screen.findByRole('button', { name: 'Ana Petrović · 12' });
        await waitFor(() => expect(bySection(asked)).toHaveLength(3));

        await userEvent.click(heading('Ana Petrović · 12'));

        // 🔒 A folded section asks the server for nothing until it is opened — which is what a grid
        // that pages per section gets in return for paging per section (docs/11 §11.3).
        await waitFor(() =>
          expect(heading('Ana Petrović · 12')).toHaveAttribute('aria-expanded', 'false'),
        );
        // An index line, not a hidden one: the real count from the server stays on the heading.
        expect(heading('Ana Petrović · 12')).toBeInTheDocument();
        expect(bySection(asked)).toHaveLength(3);

        await userEvent.click(heading('Ana Petrović · 12'));

        await waitFor(() =>
          expect(heading('Ana Petrović · 12')).toHaveAttribute('aria-expanded', 'true'),
        );
        // Opening it is what asks: the section that was folded fetches now and not before.
        await waitFor(() => expect(bySection(asked)).toHaveLength(4));
      });

      it('folds the section for what the dimension cannot place like any other', async () => {
        currentSearch = 'groupBy=person';
        const asked = watchSections();

        renderWithProviders(<DocumentsScreen />);
        await screen.findByRole('button', { name: 'Not filed (7)' });
        await waitFor(() => expect(bySection(asked)).toHaveLength(3));

        await userEvent.click(heading('Not filed (7)'));

        await waitFor(() =>
          expect(heading('Not filed (7)')).toHaveAttribute('aria-expanded', 'false'),
        );
        expect(asked.some((search) => search.includes('unassigned=person'))).toBe(true);
        expect(bySection(asked)).toHaveLength(3);
      });

      it('finds the grid as it was left after walking into a document and back', async () => {
        currentSearch = 'groupBy=person';
        watchSections();

        const first = renderWithProviders(<DocumentsScreen />);
        await screen.findByRole('button', { name: 'Ana Petrović · 12' });
        await userEvent.click(heading('Ana Petrović · 12'));
        await waitFor(() =>
          expect(heading('Ana Petrović · 12')).toHaveAttribute('aria-expanded', 'false'),
        );
        first.unmount();

        // Back, and with the filters changed on the way: what was folded is the group, not the page
        // (docs/11 §11.3).
        currentSearch = 'groupBy=person&processing=true';
        const asked = watchSections();
        renderWithProviders(<DocumentsScreen />);
        await screen.findByRole('button', { name: 'Ana Petrović · 12' });

        await waitFor(() => expect(bySection(asked)).toHaveLength(2));
        expect(heading('Ana Petrović · 12')).toHaveAttribute('aria-expanded', 'false');
        expect(asked.every((search) => !search.includes(`personId=${PERSON_ID}`))).toBe(true);
      });

      it('folds every section at once, and opens them all again', async () => {
        currentSearch = 'groupBy=person';
        const asked = watchSections();

        renderWithProviders(<DocumentsScreen />);
        await screen.findByRole('button', { name: 'Ana Petrović · 12' });
        await waitFor(() => expect(bySection(asked)).toHaveLength(3));

        await userEvent.click(
          screen.getByRole('button', { name: enMessages.documents.groupBy.collapseAll }),
        );

        await waitFor(() =>
          expect(heading('Marko Marković · 3')).toHaveAttribute('aria-expanded', 'false'),
        );
        expect(heading('Ana Petrović · 12')).toHaveAttribute('aria-expanded', 'false');
        expect(heading('Not filed (7)')).toHaveAttribute('aria-expanded', 'false');

        await userEvent.click(
          screen.getByRole('button', { name: enMessages.documents.groupBy.expandAll }),
        );

        await waitFor(() =>
          expect(heading('Marko Marković · 3')).toHaveAttribute('aria-expanded', 'true'),
        );
        // 🔒 Folding is not a filter: it narrows nothing, and it is deliberately not in the URL,
        // where a dozen folded groups make a link nobody can read (docs/11 §11.3).
        expect(replace).not.toHaveBeenCalled();
      });
    });
  });

  it('tells a fresh instance what to do about it, and only offers the fix to an admin', async () => {
    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json(envelope({ items: [], nextCursor: null })),
      ),
    );

    const asUser = renderWithProviders(<DocumentsScreen />);
    expect(await screen.findByText(enMessages.documents.empty.instance)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enMessages.documents.empty.addLibrary }),
    ).not.toBeInTheDocument();
    asUser.unmount();

    renderWithProviders(<DocumentsScreen />, { user: TEST_ADMIN });
    expect(
      await screen.findByRole('button', { name: enMessages.documents.empty.addLibrary }),
    ).toBeInTheDocument();
  });

  it('says so plainly when the filters match nothing', async () => {
    currentSearch = 'processing=true';
    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json(envelope({ items: [], nextCursor: null })),
      ),
    );

    renderWithProviders(<DocumentsScreen />, { user: TEST_ADMIN });

    expect(await screen.findByText(enMessages.documents.empty.filtered)).toBeInTheDocument();
    // The library CTA belongs to an empty instance, not to an over-filtered view.
    expect(
      screen.queryByRole('button', { name: enMessages.documents.empty.addLibrary }),
    ).not.toBeInTheDocument();
  });

  // The poll is a real 5 s interval (docs/10 §10.5), so this waits it out.
  it(
    'keeps refreshing while a visible document is still processing',
    { timeout: 25_000 },
    async () => {
      let calls = 0;
      server.use(
        http.get('/api/documents', () => {
          calls += 1;
          return HttpResponse.json(
            envelope({
              items: [documentAt(1, { processing: calls === 1 })],
              nextCursor: null,
            }),
          );
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      expect(await screen.findByText(enMessages.documents.badges.processing)).toBeInTheDocument();

      // Once nothing on screen is processing, the polling stops on its own.
      await waitFor(
        () =>
          expect(
            screen.queryByText(enMessages.documents.badges.processing),
          ).not.toBeInTheDocument(),
        { timeout: 15_000 },
      );
      const settled = calls;
      await new Promise((resolve) => setTimeout(resolve, 7000));
      expect(calls).toBe(settled);
    },
  );

  // What the screen does with a chosen file is hand it over: the queue and the panel beside the grid
  // are where it is sent and watched (docs/11 §11.3, §11.3a).
  describe('uploading', () => {
    it('sends a chosen file and stands nothing in the grid for it', async () => {
      let uploadedName: string | null = null;
      server.use(
        http.post('/api/documents', ({ request }) => {
          uploadedName = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
          return HttpResponse.json(
            envelope({ document: { ...documentAt(9), title: 'Contract' }, created: true }),
          );
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.upload(
        fileInput(),
        new File(['hello'], 'Contract.pdf', { type: 'application/pdf' }),
      );

      await waitFor(() => expect(uploadedName).toBe('Contract.pdf'));
      // 🔒 The grid used to open with a grey placeholder card per queued file; it holds real
      // documents only now, whatever is going up (docs/11 §11.3).
      expect(screen.queryByText('Contract.pdf')).toBeNull();
    });

    it('hands over every file that was chosen, in the order they were chosen', async () => {
      const sent: string[] = [];
      server.use(
        http.post('/api/documents', ({ request }) => {
          sent.push(decodeURIComponent(request.headers.get('x-legere-filename') ?? ''));
          return HttpResponse.json(envelope({ document: documentAt(9), created: true }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.upload(fileInput(), [
        new File(['a'], 'First.pdf', { type: 'application/pdf' }),
        new File(['b'], 'Second.pdf', { type: 'application/pdf' }),
        new File(['c'], 'Third.pdf', { type: 'application/pdf' }),
      ]);

      await waitFor(() => expect(sent).toEqual(['First.pdf', 'Second.pdf', 'Third.pdf']));
      for (const name of ['First.pdf', 'Second.pdf', 'Third.pdf']) {
        expect(screen.queryByText(name)).toBeNull();
      }
    });

    it('leaves the grid alone when a file is refused', async () => {
      let refused = false;
      server.use(
        http.post('/api/documents', () => {
          refused = true;
          return HttpResponse.json(
            { error: { code: 'DOCUMENT_DUPLICATE', message: 'duplicate', details: null } },
            { status: 409 },
          );
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.upload(
        fileInput(),
        new File(['x'], 'Twice.pdf', { type: 'application/pdf' }),
      );

      // The reason and the retry belong to the row in the panel (docs/11 §11.3a); the grid says
      // nothing at all about a file that never became a document.
      await waitFor(() => expect(refused).toBe(true));
      expect(screen.queryByText(/Twice\.pdf/)).toBeNull();
      expect(screen.getByText('Document 1')).toBeInTheDocument();
    });

    it('highlights the card an upload has just become, and only that one', async () => {
      let landed = false;
      server.use(
        http.get('/api/documents', () =>
          HttpResponse.json(
            envelope({
              items: landed ? [documentAt(9), documentAt(1)] : [documentAt(1)],
              nextCursor: null,
            }),
          ),
        ),
        http.post('/api/documents', () => {
          landed = true;
          return HttpResponse.json(envelope({ document: documentAt(9), created: true }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      await userEvent.upload(
        fileInput(),
        new File(['x'], 'Ninth.pdf', { type: 'application/pdf' }),
      );

      // The eye carries from the row in the panel to the thing that arrived (docs/11 §11.3)…
      await waitFor(() =>
        expect(screen.getByText('Document 9').closest('.legere-just-uploaded')).not.toBeNull(),
      );
      // …and to that card alone: the rest of the grid did not move.
      expect(screen.getByText('Document 1').closest('.legere-just-uploaded')).toBeNull();
    });

    it('does not say "no documents" while the first upload is still going', async () => {
      let release: () => void = () => {};
      server.use(
        http.get('/api/documents', () =>
          HttpResponse.json(envelope({ items: [], nextCursor: null })),
        ),
        http.post('/api/documents', async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return HttpResponse.json(envelope({ document: documentAt(9), created: true }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      expect(await screen.findByText(enMessages.documents.empty.instance)).toBeInTheDocument();

      await userEvent.upload(
        fileInput(),
        new File(['x'], 'First.pdf', { type: 'application/pdf' }),
      );

      // An empty archive that answered "no documents" in the middle of its first upload would be
      // telling the person the opposite of what is happening (docs/11 §11.3).
      await waitFor(() =>
        expect(screen.queryByText(enMessages.documents.empty.instance)).toBeNull(),
      );

      release();
      // And it comes back once nothing is on its way any more.
      expect(await screen.findByText(enMessages.documents.empty.instance)).toBeInTheDocument();
    });
  });

  describe('combining documents from the grid (docs/11 §11.3)', () => {
    it('picks a document by its card, and does not open it while picking', async () => {
      renderWithProviders(<DocumentsScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.documents.selection.start }),
      );

      // The card *is* the checkbox while picking: the whole of it, not a tick in its corner.
      const card = screen.getByRole('checkbox', { name: 'Document 2' });
      expect(card).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(card);
      expect(card).toHaveAttribute('aria-checked', 'true');

      // 🔒 And the same press does not also open the document: one gesture, one meaning.
      expect(screen.queryByRole('link', { name: /Document 2/ })).not.toBeInTheDocument();

      await userEvent.click(card);
      expect(card).toHaveAttribute('aria-checked', 'false');
    });

    it('gives the card its link back the moment picking stops', async () => {
      renderWithProviders(<DocumentsScreen />);
      const start = await screen.findByRole('button', {
        name: enMessages.documents.selection.start,
      });
      await userEvent.click(start);
      expect(screen.getByRole('checkbox', { name: 'Document 2' })).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole('button', { name: enMessages.documents.selection.cancel }),
      );

      // Nothing on the grid answers as a checkbox any more: the mode is the only thing deciding what
      // a press means, so leaving it hands the card back to the link it is the rest of the time.
      expect(screen.queryByRole('checkbox', { name: 'Document 2' })).not.toBeInTheDocument();
      expect(screen.getByText('Document 2')).toBeInTheDocument();
    });

    it('moves the files into the first-picked document, in the order they were ticked', async () => {
      let combined: unknown = null;
      let target = '';
      server.use(
        http.post('/api/documents/:id/combine', async ({ params, request }) => {
          target = String(params.id);
          combined = await request.json();
          return HttpResponse.json(envelope({ ...detailOf(2), fileCount: 3 }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.documents.selection.start }),
      );
      await userEvent.click(screen.getByRole('checkbox', { name: 'Document 2' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Document 1' }));
      await userEvent.click(
        screen.getByRole('button', { name: enMessages.documents.selection.combine }),
      );

      // The first one ticked keeps its identity; the rest are appended to it in that order.
      await waitFor(() => expect(target).toBe(documentAt(2).id));
      expect(combined).toEqual({ documentIds: [documentAt(1).id] });
      // The result is rebuilding, and the viewer is where that is watched.
      expect(push).toHaveBeenCalledWith(`/documents/${documentAt(2).id}`);
    });

    it('will not combine one document with nothing', async () => {
      renderWithProviders(<DocumentsScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.documents.selection.start }),
      );

      const combine = screen.getByRole('button', { name: enMessages.documents.selection.combine });
      expect(combine).toBeDisabled();

      await userEvent.click(screen.getByRole('checkbox', { name: 'Document 1' }));
      expect(combine).toBeDisabled();

      // Any documents can be combined, not only images (docs/11 §11.3).
      await userEvent.click(screen.getByRole('checkbox', { name: 'Document 2' }));
      expect(combine).not.toBeDisabled();
    });
  });

  describe('"these look like one document" (docs/11 §11.3)', () => {
    const group = {
      documentIds: [documentAt(1).id, documentAt(2).id],
      libraryId: 'cccccccc-3333-4333-8333-333333333333',
      libraryName: 'Invoices',
      folder: 'passports/2026',
      reason: 'NAME_SEQUENCE',
    };

    it('offers the group above the grid and combines it on one press', async () => {
      let target = '';
      let combined: unknown = null;
      server.use(
        http.get('/api/documents/grouping-suggestions', () =>
          HttpResponse.json(envelope({ items: [group] })),
        ),
        http.post('/api/documents/:id/combine', async ({ params, request }) => {
          target = String(params.id);
          combined = await request.json();
          return HttpResponse.json(envelope({ ...detailOf(1), fileCount: 2 }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);

      expect(
        await screen.findByText(/2 scans in Invoices\/passports\/2026, one after another/),
      ).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole('button', { name: enMessages.documents.suggestions.combine }),
      );

      await waitFor(() => expect(target).toBe(documentAt(1).id));
      expect(combined).toEqual({ documentIds: [documentAt(2).id] });
    });

    it('takes a dismissal on the client, because the server never remembers being refused', async () => {
      let asked = 0;
      const dismissable = { ...group, documentIds: [documentAt(3).id, documentAt(4).id] };
      server.use(
        http.get('/api/documents/grouping-suggestions', () => {
          asked += 1;
          return HttpResponse.json(envelope({ items: [dismissable] }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText(/2 scans in Invoices\/passports\/2026/);

      await userEvent.click(
        screen.getByRole('button', { name: enMessages.documents.suggestions.dismiss }),
      );

      expect(screen.queryByText(/2 scans in Invoices/)).toBeNull();
      // Nothing was told to the server about it — a suggestion is computed, not stored.
      expect(asked).toBe(1);
    });

    it('says nothing at all when the grid is being filtered', async () => {
      currentSearch = 'processing=true';
      let asked = 0;
      server.use(
        http.get('/api/documents/grouping-suggestions', () => {
          asked += 1;
          return HttpResponse.json(envelope({ items: [group] }));
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await screen.findByText('Document 1');

      // A proposal about the whole shelf makes no sense over a filtered view of it.
      expect(asked).toBe(0);
      expect(screen.queryByText(enMessages.documents.suggestions.title)).toBeNull();
    });
  });
});

// What `POST /combine` answers with: the surviving document, whole (docs/07 §7.3).
function detailOf(index: number): Record<string, unknown> {
  return {
    ...documentAt(index),
    auto: {},
    // The detail says in addition whether the catalogue still holds each name (docs/03 §3.3.19).
    people: [],
    subjects: [],
    ocrUsed: false,
    description: null,
    pageFormat: 'AUTO',
    titleSource: 'NONE',
    typeSource: 'NONE',
    steps: {
      canonical: 'PENDING',
      preview: 'PENDING',
      markdown: 'PENDING',
      analysis: 'PENDING',
      fields: 'PENDING',
      vectorization: 'PENDING',
    },
    skipReasons: {},
    languages: [],
    country: null,
    city: null,
    processingError: null,
    failedStep: null,
    files: [],
    createdBy: null,
    extracted: null,
  };
}
