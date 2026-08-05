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

  it('queues the chosen files as cards and sends them one at a time', async () => {
    const sent: string[] = [];
    let inFlight = 0;
    server.use(
      http.post('/api/documents', async ({ request }) => {
        inFlight += 1;
        // 🔒 One at a time: forty parallel uploads saturate the connection and arrive interleaved
        // (docs/11 §11.3).
        expect(inFlight).toBe(1);
        sent.push(decodeURIComponent(request.headers.get('x-legere-filename') ?? ''));
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return HttpResponse.json(envelope({ document: documentAt(9), created: true }));
      }),
    );

    renderWithProviders(<DocumentsScreen isAdmin={false} />);
    await screen.findByText('Document 1');

    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
    await userEvent.upload(input, [
      new File(['a'], 'First.pdf', { type: 'application/pdf' }),
      new File(['b'], 'Second.pdf', { type: 'application/pdf' }),
      new File(['c'], 'Third.pdf', { type: 'application/pdf' }),
    ]);

    // On the screen before a byte is sent, in the order they were chosen.
    expect(screen.getByText('Third.pdf')).toBeInTheDocument();

    await waitFor(() => expect(sent).toEqual(['First.pdf', 'Second.pdf', 'Third.pdf']));
    // Each placeholder goes as its document arrives.
    await waitFor(() => expect(screen.queryByText('Third.pdf')).toBeNull());
  });

  it('leaves a failed file on the screen and carries on with the rest', async () => {
    server.use(
      http.post('/api/documents', ({ request }) => {
        const name = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
        return name === 'Bad.pdf'
          ? HttpResponse.json(
              { error: { code: 'DOCUMENT_DUPLICATE', message: 'duplicate', details: null } },
              { status: 409 },
            )
          : HttpResponse.json(envelope({ document: documentAt(9), created: true }));
      }),
    );

    renderWithProviders(<DocumentsScreen isAdmin={false} />);
    await screen.findByText('Document 1');

    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
    await userEvent.upload(input, [
      new File(['a'], 'Bad.pdf', { type: 'application/pdf' }),
      new File(['b'], 'Good.pdf', { type: 'application/pdf' }),
    ]);

    // The failure keeps its own card, with what went wrong on it…
    expect(await screen.findByText(enMessages.documents.upload.failed)).toBeInTheDocument();
    expect(screen.getByText('Bad.pdf')).toBeInTheDocument();
    // …and the queue carried on regardless.
    await waitFor(() => expect(screen.queryByText('Good.pdf')).toBeNull());
  });

  describe('combining documents from the grid (docs/11 §11.3)', () => {
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
    people: [],
    documentDate: null,
    subjects: [],
    ocrUsed: false,
    description: null,
    titleSource: 'NONE',
    typeSource: 'NONE',
    steps: {
      canonical: 'PENDING',
      preview: 'PENDING',
      markdown: 'PENDING',
      analysis: 'PENDING',
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
  };
}
