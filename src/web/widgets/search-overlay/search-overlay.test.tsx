import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';

vi.mock('next/link', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

const push = vi.fn();
const replace = vi.fn();

// A screen that is not the documents grid: the overlay is raised over whatever is open, and the
// hotkey belongs to the layout above every screen rather than to any one of them (docs/11 §11.1a).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => '/collections',
}));

const RENTAL = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  title: 'Rental agreement',
  fileCount: 1,
  primaryExt: 'pdf',
  sizeBytes: '2048',
  pageCount: 2,
  documentType: { id: 'bbbbbbbb-2222-4222-8222-222222222222', slug: 'contract', name: 'Contract' },
  availability: 'AVAILABLE',
  processing: false,
  origin: 'LIBRARY',
  hasPreview: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  documentDate: null,
  people: [],
  subjects: [],
  country: null,
  city: null,
  languages: [],
};

const PASSPORT = { ...RENTAL, id: 'aaaaaaaa-2222-4222-8222-222222222222', title: 'Passport scan' };

const server = createApiMock();
const searched: string[] = [];

// The screen under the overlay, with something on it that can hold the focus — a card, a menu item,
// a tab: whatever raises the overlay is what must have the focus back afterwards.
function ScreenWithOpener() {
  return (
    <main>
      <button type="button">Open a document</button>
    </main>
  );
}

async function openWithHotkey(): Promise<void> {
  await userEvent.keyboard('{Control>}k{/Control}');
  await screen.findByRole('dialog');
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  searched.length = 0;
  server.use(
    http.get('/api/search', ({ request }) => {
      searched.push(new URL(request.url).search);
      return HttpResponse.json(
        envelope({
          items: [{ document: RENTAL, score: 0.5, snippet: 'the <mark>deposit</mark> is due' }],
          semanticAvailable: true,
        }),
      );
    }),
    http.get('/api/documents', () =>
      HttpResponse.json(envelope({ items: [PASSPORT, RENTAL], nextCursor: null })),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('the search overlay', () => {
  it('opens on the hotkey from a screen that is not the documents grid', async () => {
    renderWithProviders(<ScreenWithOpener />);

    expect(screen.queryByRole('dialog')).toBeNull();
    await openWithHotkey();

    // Raised over the screen, not navigated to: nothing underneath moved.
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(await screen.findByLabelText(enMessages.search.placeholder)).toHaveFocus();
  });

  it('answers an empty query with the recent documents', async () => {
    renderWithProviders(<ScreenWithOpener />);
    await openWithHotkey();

    // The same source the search page's empty state reads (docs/11 §11.6): the newest arrivals.
    expect(await screen.findByText('Passport scan')).toBeInTheDocument();
    expect(screen.getByText(enMessages.search.recent)).toBeInTheDocument();
    expect(searched).toHaveLength(0);
  });

  it('searches as the query is typed, debounced, in the default hybrid mode', async () => {
    renderWithProviders(<ScreenWithOpener />);
    await openWithHotkey();

    await userEvent.type(screen.getByLabelText(enMessages.search.placeholder), 'deposit');

    // One request for the word, not one per letter (docs/11 §11.1a).
    await waitFor(() => expect(searched).toHaveLength(1));
    expect(searched[0]).toContain('q=deposit');
    expect(searched[0]).toContain('mode=hybrid');
    // The row's anatomy is the search page's: thumbnail, title, the highlighted snippet, the type.
    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    expect((await screen.findByText('deposit')).tagName).toBe('MARK');
    expect(screen.getByText('Contract')).toBeInTheDocument();
  });

  it('says nothing found in the words the search page uses', async () => {
    server.use(
      http.get('/api/search', () =>
        HttpResponse.json(envelope({ items: [], semanticAvailable: true })),
      ),
    );
    renderWithProviders(<ScreenWithOpener />);
    await openWithHotkey();

    await userEvent.type(screen.getByLabelText(enMessages.search.placeholder), 'deposit');

    expect(await screen.findByText(enMessages.search.noResults)).toBeInTheDocument();
    expect(screen.getByText(enMessages.search.noResultsHint)).toBeInTheDocument();
  });

  it('walks the results with the arrows, opens one with Enter, and gives the focus back on Escape', async () => {
    renderWithProviders(<ScreenWithOpener />);
    const opener = screen.getByRole('button', { name: 'Open a document' });
    await userEvent.click(opener);

    await openWithHotkey();
    const input = screen.getByLabelText(enMessages.search.placeholder);
    await userEvent.type(input, 'deposit');
    await screen.findByText('Rental agreement');

    // ↑/↓ move a highlight that is visibly the highlighted one.
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'),
    );

    // Escape closes and 🔒 the focus goes back where it came from.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
    expect(push).not.toHaveBeenCalled();

    // And Enter on a highlighted row opens that document.
    await openWithHotkey();
    await userEvent.type(screen.getByLabelText(enMessages.search.placeholder), 'deposit');
    await screen.findByText('Rental agreement');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(push).toHaveBeenCalledWith(`/documents/${RENTAL.id}`);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('goes to the page with what was typed — on Enter with nothing highlighted, and on All results', async () => {
    renderWithProviders(<ScreenWithOpener />);
    await openWithHotkey();

    await userEvent.type(screen.getByLabelText(enMessages.search.placeholder), 'deposit{Enter}');
    expect(push).toHaveBeenCalledWith('/search?q=deposit');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    push.mockClear();
    await openWithHotkey();
    await userEvent.type(screen.getByLabelText(enMessages.search.placeholder), 'rent & lease');
    await screen.findByText('Rental agreement');
    const dialog = screen.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.search.allResults }),
    );

    // The query is carried as it was typed, escaped for the address it is going into.
    expect(push).toHaveBeenCalledWith('/search?q=rent%20%26%20lease');
  });
});
