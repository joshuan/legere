import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { SearchScreen } from './search-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const replace = vi.fn();
let currentSearch = 'q=invoice';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/search',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

const hit = {
  document: {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    title: 'Rental agreement',
    fileCount: 1,
    primaryExt: 'pdf',
    sizeBytes: '2048',
    pageCount: 2,
    documentType: {
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      slug: 'contract',
      name: 'Contract',
    },
    availability: 'AVAILABLE',
    processing: false,
    origin: 'LIBRARY',
    hasPreview: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    // What a card may show (docs/07 §7.3); the results keep the arrangement they have always had.
    documentDate: null,
    people: [],
    subjects: [],
    country: null,
    city: null,
    languages: [],
    extractedSummary: null,
  },
  score: 0.0166,
  snippet: 'the <mark>deposit</mark> is due before occupancy',
  // Why the row is here (docs/07 §7.3, docs/11 §11.6).
  matchedIn: ['text'],
};

const server = createApiMock();

function serve(body: { items: unknown[]; semanticAvailable: boolean }): void {
  server.use(
    http.get('/api/search', () => HttpResponse.json(envelope(body))),
    http.get('/api/libraries', () => HttpResponse.json(envelope({ items: [] }))),
    http.get('/api/document-types', () => HttpResponse.json(envelope({ items: [] }))),
    // The recent documents an empty query is answered with (docs/11 §11.6).
    http.get('/api/documents', () =>
      HttpResponse.json(envelope({ items: [hit.document], nextCursor: null })),
    ),
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  currentSearch = 'q=invoice';
  serve({ items: [hit], semanticAvailable: true });
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('SearchScreen', () => {
  it('shows results with the matched words highlighted', async () => {
    renderWithProviders(<SearchScreen />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    const marked = await screen.findByText('deposit');
    // <mark> comes from ts_headline and is the only markup the snippet may carry (docs/07 §7.3).
    expect(marked.tagName).toBe('MARK');
    expect(screen.getByText('Contract')).toBeInTheDocument();
  });

  // 🔒 A box with a magnifying glass in it is a promise nobody can read the terms of, and an empty
  // answer to a file name teaches people the archive does not hold what it holds (docs/11 §11.6).
  it('says what it is looking at, before anything is typed', async () => {
    renderWithProviders(<SearchScreen />);

    expect(await screen.findByText(enMessages.search.reach)).toBeInTheDocument();
  });

  it('says of every result why it is here', async () => {
    serve({
      items: [
        { ...hit, matchedIn: ['fileName'] },
        {
          ...hit,
          document: { ...hit.document, id: 'ffffffff-3333-4333-8333-333333333333' },
          snippet: null,
          matchedIn: ['meaning'],
        },
      ],
      semanticAvailable: true,
    });
    renderWithProviders(<SearchScreen />);

    await screen.findAllByText('Rental agreement');
    expect(screen.getByText(enMessages.search.matchedIn.fileName)).toBeInTheDocument();
    expect(screen.getByText(enMessages.search.matchedIn.meaning)).toBeInTheDocument();
    expect(screen.getAllByText(enMessages.search.why)).toHaveLength(2);
  });

  // The recent documents an empty query answers with are not results, and nothing matched them.
  it('tags nothing where nothing was searched for', async () => {
    currentSearch = '';
    renderWithProviders(<SearchScreen />);

    await screen.findByText('Rental agreement');
    expect(screen.queryByText(enMessages.search.why)).not.toBeInTheDocument();
  });

  it('puts a new query into the URL, so a search can be linked', async () => {
    renderWithProviders(<SearchScreen />);
    await screen.findByText('Rental agreement');

    const input = screen.getByLabelText(enMessages.search.placeholder);
    await userEvent.clear(input);
    await userEvent.type(input, 'passport{enter}');

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/search?q=passport'));
  });

  it('sends the mode chosen in the URL', async () => {
    currentSearch = 'q=invoice&mode=text';
    const seen: string[] = [];
    server.use(
      http.get('/api/search', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [hit], semanticAvailable: true }));
      }),
    );

    renderWithProviders(<SearchScreen />);
    await screen.findByText('Rental agreement');

    expect(seen[0]).toContain('mode=text');
  });

  it('disables semantic mode when the instance has no provider, and says why', async () => {
    serve({ items: [], semanticAvailable: false });

    renderWithProviders(<SearchScreen />);

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: enMessages.search.modes.semantic })).toBeDisabled(),
    );
    // Disabled rather than hidden, with the reason on hover (docs/11 §11.6).
    expect(screen.getByRole('radio', { name: enMessages.search.modes.text })).not.toBeDisabled();
  });

  it('shows the recent documents before anything has been typed', async () => {
    currentSearch = '';

    renderWithProviders(<SearchScreen />);

    // One behaviour, described once: the overlay's empty state is this one (docs/11 §11.6, §11.1a).
    expect(await screen.findByText(enMessages.search.recent)).toBeInTheDocument();
    expect(screen.getByText('Rental agreement')).toBeInTheDocument();
  });

  it('runs the query the URL arrived with, without waiting to be asked again', async () => {
    // The address somebody pasted into a chat has to be the search, not a form remembering the
    // words (docs/11 §11.6).
    currentSearch = 'q=invoice';
    const seen: string[] = [];
    serve({ items: [hit], semanticAvailable: true });
    server.use(
      http.get('/api/search', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [hit], semanticAvailable: true }));
      }),
    );

    renderWithProviders(<SearchScreen />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    // One request, from the URL alone: nothing was typed and nothing was submitted.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('q=invoice');
    expect(replace).not.toHaveBeenCalled();
  });

  it('suggests what to try when nothing matched', async () => {
    serve({ items: [], semanticAvailable: true });

    renderWithProviders(<SearchScreen />);

    expect(await screen.findByText(enMessages.search.noResults)).toBeInTheDocument();
    expect(screen.getByText(enMessages.search.noResultsHint)).toBeInTheDocument();
  });
});
