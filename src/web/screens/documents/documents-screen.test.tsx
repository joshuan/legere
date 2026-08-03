import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentsScreen } from './documents-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

// The screen reads its filters from the URL and writes them back through the router (docs/11 §11.3).
const replace = vi.fn();
const push = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => '/documents',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

function documentAt(index: number, overrides: Partial<DocumentListDto> = {}): DocumentListDto {
  return {
    id: `aaaaaaaa-1111-4111-8111-00000000000${index}`,
    title: `Document ${index}`,
    ext: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: '2048',
    pageCount: 1,
    category: null,
    availability: 'AVAILABLE',
    processing: false,
    source: 'LIBRARY',
    hasPreview: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  currentSearch = '';
  server.use(
    http.get('/api/documents', () =>
      HttpResponse.json(envelope({ items: [documentAt(1), documentAt(2)], nextCursor: null })),
    ),
    http.get('/api/libraries', () =>
      HttpResponse.json(
        envelope({ items: [{ id: 'cccccccc-3333-4333-8333-333333333333', name: 'Invoices' }] }),
      ),
    ),
    http.get('/api/categories', () =>
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
    currentSearch = 'source=DERIVED&processing=true';
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [documentAt(1)], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    expect(seen[0]).toContain('source=DERIVED');
    expect(seen[0]).toContain('processing=true');
  });

  it('writes a chosen filter back into the URL, so the view can be linked', async () => {
    renderWithProviders(<DocumentsScreen />);
    await screen.findByText('Document 1');

    await userEvent.click(
      screen.getByRole('switch', { name: enMessages.documents.filters.processingOnly }),
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/documents?processing=true'));
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

    renderWithProviders(<DocumentsScreen isAdmin />);
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

    renderWithProviders(<DocumentsScreen isAdmin />);

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

  it('uploads a chosen file and refreshes the grid with it', async () => {
    let uploadedName: string | null = null;
    server.use(
      http.post('/api/documents', async ({ request }) => {
        uploadedName = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
        // The body is the file itself, not multipart (docs/07 §7.3).
        expect(await request.arrayBuffer()).toHaveProperty('byteLength', 5);
        return HttpResponse.json(
          envelope({ document: { ...documentAt(9), title: 'Contract' }, created: true }),
        );
      }),
    );

    renderWithProviders(<DocumentsScreen isAdmin={false} />);
    await screen.findByText('Document 1');

    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
    await userEvent.upload(input, new File(['hello'], 'Contract.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(uploadedName).toBe('Contract.pdf'));
  });

  it('reports a rejected file by name and keeps the screen usable', async () => {
    server.use(
      http.post('/api/documents', () =>
        HttpResponse.json(
          { error: { code: 'DOCUMENT_DUPLICATE', message: 'duplicate', details: null } },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<DocumentsScreen isAdmin={false} />);
    await screen.findByText('Document 1');

    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
    await userEvent.upload(input, new File(['x'], 'Twice.pdf', { type: 'application/pdf' }));

    // The name matters: a batch of ten uploads must say which one was refused.
    await waitFor(() => expect(screen.getByText(/Twice\.pdf/)).toBeInTheDocument());
  });

  describe('building a scan set from the grid (docs/11 §11.8)', () => {
    it('creates a set from the selected images, in selection order', async () => {
      let created: unknown = null;
      server.use(
        http.get('/api/documents', () =>
          HttpResponse.json(
            envelope({
              items: [
                documentAt(1, { mimeType: 'image/jpeg', title: 'Scan A' }),
                documentAt(2, { mimeType: 'image/jpeg', title: 'Scan B' }),
              ],
              nextCursor: null,
            }),
          ),
        ),
        http.post('/api/scan-sets', async ({ request }) => {
          created = await request.json();
          return HttpResponse.json(
            envelope({
              id: 'ffffffff-6666-4666-8666-666666666666',
              name: 'New scan set',
              status: 'DRAFT',
              cropMode: 'TRIM',
              itemCount: 2,
              resultDocumentId: null,
              error: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              items: [],
            }),
            { status: 201 },
          );
        }),
      );

      renderWithProviders(<DocumentsScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.documents.selection.start }),
      );
      await userEvent.click(screen.getByRole('checkbox', { name: 'Scan B' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Scan A' }));
      await userEvent.click(
        screen.getByRole('button', { name: enMessages.documents.selection.create }),
      );

      // Selection order is page order; the builder is where it gets rearranged.
      await waitFor(() =>
        expect(created).toMatchObject({
          items: [documentAt(2).id, documentAt(1).id],
          cropMode: 'TRIM',
        }),
      );
      expect(push).toHaveBeenCalledWith('/scan-sets/ffffffff-6666-4666-8666-666666666666');
    });

    it('cannot select a document that is not an image', async () => {
      server.use(
        http.get('/api/documents', () =>
          HttpResponse.json(
            envelope({
              items: [
                documentAt(1, { mimeType: 'application/pdf', title: 'A PDF' }),
                documentAt(2, { mimeType: 'image/jpeg', title: 'Scan B' }),
              ],
              nextCursor: null,
            }),
          ),
        ),
      );

      renderWithProviders(<DocumentsScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.documents.selection.start }),
      );

      // Only images can be pages (docs/03 §3.3.17), so the checkbox is simply not offered.
      expect(screen.getByRole('checkbox', { name: 'A PDF' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: 'Scan B' })).not.toBeDisabled();
    });
  });
});
