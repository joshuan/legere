import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { libraryKeys } from '../../entities/library';
import { BrowseScreen } from './browse-screen';

const LIBRARY_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

let currentSearch = '';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

const document1 = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  title: 'January invoice',
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
  // What a card may show (docs/07 §7.3): carried on every row, drawn only where a screen asks for
  // it — and this one keeps the arrangement it has always had.
  documentDate: null,
  people: [],
  subjects: [],
  country: null,
  city: null,
  languages: [],
  extractedSummary: null,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  currentSearch = '';
  server.use(
    http.get('/api/libraries', () =>
      HttpResponse.json(envelope({ items: [{ id: LIBRARY_ID, name: 'Invoices' }] })),
    ),
    http.get(`/api/libraries/${LIBRARY_ID}/browse`, ({ request }) => {
      const path = new URL(request.url).searchParams.get('path') ?? '';
      return HttpResponse.json(
        envelope({
          path,
          folders: path === '' ? [{ name: '2026', documentCount: 3 }] : [],
          documents: { items: path === '' ? [] : [document1], nextCursor: null },
        }),
      );
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('BrowseScreen', () => {
  it('hydrates the server breadcrumb before using a library name already fetched by the shell', async () => {
    const serverClient = new QueryClient();
    const browserClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    browserClient.setQueryData(libraryKeys.visible, {
      items: [{ id: LIBRARY_ID, name: 'Invoices' }],
    });
    const ui = (client: QueryClient) => (
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <QueryClientProvider client={client}>
          <BrowseScreen libraryId={LIBRARY_ID} />
        </QueryClientProvider>
      </NextIntlClientProvider>
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(ui(serverClient));
    document.body.append(container);
    const serverBreadcrumb = within(container).getByRole('link', {
      name: enMessages.browse.library,
    });
    const onRecoverableError = vi.fn();
    const root = hydrateRoot(container, ui(browserClient), { onRecoverableError });

    try {
      await act(() => Promise.resolve());
      expect(await within(container).findByText('3 documents')).toBeInTheDocument();
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(within(container).getByRole('link', { name: 'Invoices' })).toBe(serverBreadcrumb);
    } finally {
      act(() => root.unmount());
      container.remove();
      serverClient.clear();
      browserClient.clear();
    }
  });

  it('lists the folders of the library root with their document counts', async () => {
    renderWithProviders(<BrowseScreen libraryId={LIBRARY_ID} />);

    expect(await screen.findByText('2026')).toBeInTheDocument();
    expect(screen.getByText('3 documents')).toBeInTheDocument();
    // Descending is a link, so the back button walks back up the tree.
    expect(screen.getByRole('link', { name: /2026/ })).toHaveAttribute(
      'href',
      `/browse/${LIBRARY_ID}?path=2026`,
    );
  });

  it('shows the documents of the folder in the URL, with a breadcrumb back to the root', async () => {
    currentSearch = 'path=2026%2Fq1';

    renderWithProviders(<BrowseScreen libraryId={LIBRARY_ID} />);

    expect(await screen.findByText('January invoice')).toBeInTheDocument();
    // Each breadcrumb segment links to its own level, at any depth.
    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute(
      'href',
      `/browse/${LIBRARY_ID}`,
    );
    expect(screen.getByRole('link', { name: '2026' })).toHaveAttribute(
      'href',
      `/browse/${LIBRARY_ID}?path=2026`,
    );
    expect(screen.getByRole('link', { name: 'q1' })).toHaveAttribute(
      'href',
      `/browse/${LIBRARY_ID}?path=2026%2Fq1`,
    );
  });

  it('says so when a folder holds nothing at all', async () => {
    currentSearch = 'path=empty';
    server.use(
      http.get(`/api/libraries/${LIBRARY_ID}/browse`, () =>
        HttpResponse.json(
          envelope({ path: 'empty', folders: [], documents: { items: [], nextCursor: null } }),
        ),
      ),
    );

    renderWithProviders(<BrowseScreen libraryId={LIBRARY_ID} />);

    expect(await screen.findByText(enMessages.browse.empty)).toBeInTheDocument();
  });
});
