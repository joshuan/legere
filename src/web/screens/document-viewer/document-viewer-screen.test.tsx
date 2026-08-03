import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetailDto } from '../../../shared/contracts/documents';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentViewerScreen } from './document-viewer-screen';

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CATEGORY_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

const detail: DocumentDetailDto = {
  id: ID,
  title: 'Rental agreement',
  ext: 'pdf',
  mimeType: 'application/pdf',
  sizeBytes: '2097152',
  pageCount: 4,
  category: null,
  availability: 'AVAILABLE',
  processing: false,
  source: 'LIBRARY',
  hasPreview: true,
  createdAt: '2026-01-02T10:00:00.000Z',
  contentHash: 'abc123def456abc123def456abc123def456abc123def456abc123def4561234',
  ocrUsed: true,
  categorySource: 'NONE',
  skipReasons: {},
  languages: ['ru', 'sr-Latn'],
  steps: {
    canonical: 'SKIPPED',
    preview: 'DONE',
    markdown: 'DONE',
    categorization: 'DONE',
    vectorization: 'SKIPPED',
  },
  processingError: null,
  failedStep: null,
  fileRefs: [
    {
      libraryId: 'cccccccc-3333-4333-8333-333333333333',
      libraryName: 'Invoices',
      path: 'a/rental.pdf',
      status: 'HASHED',
    },
    {
      libraryId: 'cccccccc-3333-4333-8333-333333333333',
      libraryName: 'Invoices',
      path: 'old/rental.pdf',
      status: 'MISSING',
    },
  ],
  createdBy: null,
  scanSetId: null,
};

const server = createApiMock();

function serve(
  document: DocumentDetailDto = detail,
  markdown: string | null = '# Terms\n\nBody',
): void {
  server.use(
    http.get(`/api/documents/${ID}`, () => HttpResponse.json(envelope(document))),
    http.get(`/api/documents/${ID}/markdown`, () => HttpResponse.json(envelope({ markdown }))),
    http.get('/api/categories', () =>
      HttpResponse.json(
        envelope({
          items: [
            {
              id: CATEGORY_ID,
              slug: 'contract',
              name: 'Contract',
              description: null,
              documentCount: 1,
            },
          ],
        }),
      ),
    ),
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => serve());
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('DocumentViewerScreen', () => {
  it('embeds the PDF and offers a download', async () => {
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    const embed = document.querySelector('object');
    expect(embed).toHaveAttribute('data', `/api/documents/${ID}/canonical`);
    // Both the sidebar button and the <object> fallback point at the source; either is a real way
    // to get the file.
    const downloads = screen.getAllByRole('link', { name: enMessages.viewer.download });
    expect(downloads.length).toBeGreaterThan(0);
    for (const link of downloads) {
      expect(link).toHaveAttribute('href', `/api/documents/${ID}/source`);
    }
  });

  it('renders the extracted text, without letting raw HTML through', async () => {
    serve(detail, '# Terms\n\n<script>alert(1)</script>\n\nPlain body');
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.text }));

    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeInTheDocument();
    // 🔒 Extracted text is untrusted content (docs/10 §10.8).
    expect(document.querySelector('script')).toBeNull();
  });

  it('says plainly when there is no text, and when extraction failed', async () => {
    serve(detail, null);
    const first = renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.text }));
    expect(await screen.findByText(enMessages.viewer.noText)).toBeInTheDocument();
    first.unmount();

    serve({ ...detail, steps: { ...detail.steps, markdown: 'FAILED' } }, null);
    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.text }));
    expect(await screen.findByText(enMessages.viewer.textFailed)).toBeInTheDocument();
  });

  it('shows the metadata with a copyable hash and the file locations', async () => {
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));

    expect(await screen.findByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText(/abc123def456…/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByText('a/rental.pdf')).toBeInTheDocument();
    // A file that vanished is still shown, badged for what it is.
    expect(screen.getByText('old/rental.pdf')).toBeInTheDocument();
    expect(screen.getByText(enMessages.documents.badges.unavailable)).toBeInTheDocument();
  });

  it('assigns a category', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...detail, categorySource: 'MANUAL' }));
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    const select = await screen.findByRole('combobox', { name: enMessages.viewer.category });
    await userEvent.click(select);
    await userEvent.click(await screen.findByTitle('Contract'));

    await waitFor(() => expect(patched).toEqual({ categoryId: CATEGORY_ID }));
  });

  it('marks a category the classifier chose', async () => {
    serve({
      ...detail,
      category: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
      categorySource: 'AUTO',
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText(enMessages.viewer.auto)).toBeInTheDocument();
  });

  it('disables the download of a document whose file is gone', async () => {
    serve({ ...detail, availability: 'UNAVAILABLE' });

    renderWithProviders(<DocumentViewerScreen id={ID} />);

    // antd renders a link when `href` is set; a disabled one drops the href entirely, so there is
    // nothing left to click through to.
    const download = await screen.findByText(enMessages.viewer.download);
    const control = download.closest('a, button');
    expect(control).not.toBeNull();
    expect(control?.getAttribute('href')).toBeNull();
  });

  it('shows the per-step states and the error behind a failure', async () => {
    serve({
      ...detail,
      steps: { ...detail.steps, preview: 'FAILED' },
      processingError: 'Stirling failed with 500',
      failedStep: 'preview',
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText(enMessages.viewer.processing.title)).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText(/preview: Stirling failed with 500/)).toBeInTheDocument();
  });

  it('says why a step was skipped, instead of leaving SKIPPED to look like a failure', async () => {
    server.use(
      http.get('/api/documents/:id', () =>
        HttpResponse.json(
          envelope({
            ...detail,
            steps: { ...detail.steps, canonical: 'SKIPPED', vectorization: 'SKIPPED' },
            skipReasons: { canonical: 'NOT_NEEDED', vectorization: 'NOT_CONFIGURED' },
          }),
        ),
      ),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} isAdmin={false} />);

    expect(await screen.findByText(enMessages.viewer.skipReasons.NOT_NEEDED)).toBeInTheDocument();
    // The one an admin can act on: it names what is missing from the instance.
    expect(screen.getByText(enMessages.viewer.skipReasons.NOT_CONFIGURED)).toBeInTheDocument();
  });

  it('offers reprocessing to an admin only, with the chosen steps', async () => {
    let body: unknown = null;
    server.use(
      http.post(`/api/documents/${ID}/reprocess`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(envelope({ documentId: ID, steps: ['preview'] }), { status: 201 });
      }),
    );

    const asUser = renderWithProviders(<DocumentViewerScreen id={ID} />);
    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enMessages.viewer.processing.reprocessAll }),
    ).not.toBeInTheDocument();
    asUser.unmount();

    renderWithProviders(<DocumentViewerScreen id={ID} isAdmin />);
    const panel = await screen.findByText(enMessages.viewer.processing.title);
    const card = panel.closest('.ant-card');
    if (!(card instanceof HTMLElement)) throw new Error('expected the processing card');

    await userEvent.click(
      within(card).getByRole('checkbox', { name: enMessages.viewer.steps.preview }),
    );
    await userEvent.click(within(card).getByRole('button', { name: /Reprocess 1 steps/ }));

    await waitFor(() => expect(body).toEqual({ steps: ['preview'] }));
  });
});
