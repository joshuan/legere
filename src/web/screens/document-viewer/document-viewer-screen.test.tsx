import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetailDto } from '../../../shared/contracts/documents';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentViewerScreen } from './document-viewer-screen';

// The viewer puts the open tab in the address (docs/11 §11.5), so it needs a router.
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CATEGORY_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

const detail: DocumentDetailDto = {
  id: ID,
  title: 'Rental agreement',
  ext: 'pdf',
  mimeType: 'application/pdf',
  sizeBytes: '2097152',
  pageCount: 4,
  documentType: null,
  availability: 'AVAILABLE',
  processing: false,
  source: 'LIBRARY',
  hasPreview: true,
  createdAt: '2026-01-02T10:00:00.000Z',
  contentHash: 'abc123def456abc123def456abc123def456abc123def456abc123def4561234',
  ocrUsed: true,
  typeSource: 'NONE',
  skipReasons: {},
  auto: {},
  people: [],
  documentDate: null,
  subjects: [],
  languages: ['ru', 'sr-Latn'],
  country: 'ME',
  city: 'Podgorica',
  steps: {
    canonical: 'SKIPPED',
    preview: 'DONE',
    markdown: 'DONE',
    analysis: 'DONE',
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
    http.get('/api/document-types', () =>
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

  it('assigns a documentType', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...detail, typeSource: 'MANUAL' }));
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    // Scoped to the tab: the title above the tabs has an Edit affordance of its own.
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

    const select = await screen.findByRole('combobox', { name: enMessages.viewer.documentType });
    await userEvent.click(select);
    await userEvent.click(await screen.findByTitle('Contract'));

    // 🔒 Nothing is sent while the form is open: a select that writes on every keystroke turns a
    // glance into an edit (docs/11 §11.5).
    expect(patched).toBeNull();

    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));
    await waitFor(() => expect(patched).toEqual({ typeId: CATEGORY_ID }));
  });

  it('sends only the fields that changed, so a save is not a manual assignment of everything', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

    const city = details.getByRole('textbox', { name: enMessages.viewer.details.city });
    await userEvent.clear(city);
    await userEvent.type(city, 'Bar');
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    // 🔒 The documentType was not touched, so it is not in the payload: sending it would flip
    // typeSource to MANUAL and a classifier's choice would silently become a person's
    // (docs/03 §3.3.10).
    await waitFor(() => expect(patched).toEqual({ city: 'Bar' }));
  });

  it('offers a language by its name, not only the ones already on the document', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

    const languages = details.getByRole('combobox', { name: enMessages.viewer.details.languages });
    await userEvent.click(languages);
    // 🔒 Searched by the name: German is on no list this document carries, and nobody should have to
    // know it is `de` to say it (docs/11 §11.5).
    await userEvent.type(languages, 'German');
    await userEvent.click(await screen.findByTitle('German (de)'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    await waitFor(() => expect(patched).toEqual({ languages: ['ru', 'sr-Latn', 'de'] }));
  });

  it('drops an edit that is cancelled', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));
    await userEvent.type(
      details.getByRole('textbox', { name: enMessages.viewer.details.city }),
      'Bar',
    );
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.cancel }));

    expect(patched).toBeNull();
    expect(details.queryByRole('textbox', { name: enMessages.viewer.details.city })).toBeNull();
  });

  it('opens the editor on E, and closes it on Escape', async () => {
    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));

    await userEvent.keyboard('e');
    expect(details.getByRole('textbox', { name: enMessages.viewer.details.city })).toBeVisible();

    // 🔒 And not while typing: an "e" in a city name must stay an "e" (docs/11 §11.5).
    await userEvent.type(
      details.getByRole('textbox', { name: enMessages.viewer.details.city }),
      'e',
    );
    await userEvent.keyboard('{Escape}');
    expect(details.queryByRole('textbox', { name: enMessages.viewer.details.city })).toBeNull();
  });

  it('puts a field back to what the pipeline read', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );
    serve({ ...detail, city: 'Bar', auto: { city: 'Podgorica' } });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));
    await userEvent.click(details.getByRole('button', { name: enMessages.viewer.details.reset }));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    // 🔒 A reset travels as a reset, not as the same value typed in: sending the value would mark
    // it as somebody's choice, which is the opposite of what was asked (docs/03 §3.3.10).
    await waitFor(() => expect(patched).toEqual({ reset: ['city', 'country'] }));
  });

  it('puts a field back to what was read in one click, without opening the form', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );
    serve({ ...detail, languages: ['en'], auto: { languages: ['ru'] } });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));

    // No Edit: reading "English, read as Russian" and agreeing with the machine is one gesture
    // (docs/11 §11.5).
    await userEvent.click(details.getByRole('button', { name: /read as Russian/ }));

    // 🔒 And it travels as a reset, not as the value: sending `ru` back would claim somebody chose
    // it (docs/03 §3.3.10).
    await waitFor(() => expect(patched).toEqual({ reset: ['languages'] }));
  });

  it('leaves the line as plain text inside the form, where the reset button already answers', async () => {
    serve({ ...detail, languages: ['en'], auto: { languages: ['ru'] } });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

    // Two ways back from one row would be two answers to the same question.
    expect(details.queryByRole('button', { name: /read as Russian/ })).toBeNull();
    expect(details.getByText(/read as Russian/)).toBeInTheDocument();
    expect(details.getByRole('button', { name: enMessages.viewer.details.reset })).toBeVisible();
  });

  it('tells the history of the document, newest first', async () => {
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(
          envelope({
            items: [
              {
                id: 'eeeeeeee-3333-4333-8333-333333333333',
                type: 'META_CHANGED',
                at: '2026-08-03T12:00:00.000Z',
                actor: 'Admin',
                payload: { changes: { city: { from: 'Podgorica', to: 'Bar' } } },
              },
              {
                id: 'eeeeeeee-2222-4222-8222-222222222222',
                type: 'STEP_FINISHED',
                at: '2026-08-03T11:00:00.000Z',
                actor: null,
                payload: { step: 'markdown', status: 'FAILED', error: 'Docling failed with 404' },
              },
              {
                id: 'eeeeeeee-1111-4111-8111-111111111111',
                type: 'CREATED',
                at: '2026-08-03T10:00:00.000Z',
                actor: null,
                payload: { source: 'LIBRARY', path: 'contracts/ticket.pdf' },
              },
            ],
            nextCursor: null,
          }),
        ),
      ),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

    // A correction reads as what it changed, from what to what.
    expect(await screen.findByText(/City: Podgorica → Bar/)).toBeInTheDocument();
    // 🔒 A failure carries the message with it: the log is where you go when something went wrong.
    expect(screen.getByText('Docling failed with 404')).toBeInTheDocument();
    expect(screen.getByText(/contracts\/ticket.pdf/)).toBeInTheDocument();
    // Who did it, where somebody did.
    expect(screen.getByText(/Admin/)).toBeInTheDocument();
  });

  it('picks up the text as soon as the step that produces it finishes', async () => {
    let extracted = false;
    server.use(
      http.get(`/api/documents/${ID}`, () =>
        HttpResponse.json(
          envelope({
            ...detail,
            processing: !extracted,
            steps: { ...detail.steps, markdown: extracted ? 'DONE' : 'RUNNING' },
          }),
        ),
      ),
      http.get(`/api/documents/${ID}/markdown`, () =>
        HttpResponse.json(envelope({ markdown: extracted ? '# Terms\n\nBody' : null })),
      ),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />);
    expect(await screen.findByText(enMessages.viewer.textPending)).toBeInTheDocument();

    // The pipeline finishes; the next poll of the document sees a step that moved.
    extracted = true;

    // 🔒 The text arrives without a reload: a viewer that shows "being extracted" over a document
    // that finished a minute ago is worse than one that never claimed to be live (docs/10 §10.5).
    expect(
      await screen.findByRole('heading', { name: 'Terms' }, { timeout: 10_000 }),
    ).toBeVisible();
  }, 15_000);

  it('keeps the open tab in the address', async () => {
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.text }));

    expect(replace).toHaveBeenCalledWith(`/documents/${ID}/text`);
  });

  it('marks a documentType the classifier chose', async () => {
    serve({
      ...detail,
      documentType: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
      typeSource: 'AUTO',
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));

    expect(await screen.findByText(enMessages.viewer.auto)).toBeInTheDocument();
  });

  it('keeps what the pipeline read under what a person made of it', async () => {
    serve({
      ...detail,
      documentType: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
      typeSource: 'MANUAL',
      languages: ['sr-Latn'],
      city: 'Bar',
      country: 'ME',
      // 🔒 The machine's answer survives the correction (docs/03 §3.3.10).
      auto: { typeSlug: 'invoice', languages: ['hr'], city: 'Podgorica', country: 'ME' },
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));

    // The catalogue here holds only "contract", so the documentType it read is named by its slug —
    // which is still the answer, and better than hiding it.
    expect(await screen.findByText(/read as invoice/)).toBeInTheDocument();
    expect(screen.getByText(/read as Podgorica, Montenegro/)).toBeInTheDocument();
    // The country was right and only the city was corrected — the note carries the whole place, so
    // there is one thing to compare rather than two.
    expect(screen.queryByText(/read as Croatian/)).toBeInTheDocument();
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
    // 🔒 Under the step that failed, not at the bottom of the card: an error that names no step is
    // an error nobody can act on (docs/11 §11.5).
    const failed = screen.getByText('Stirling failed with 500');
    expect(failed.previousElementSibling?.textContent).toBe(enMessages.viewer.steps.preview);
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

  it('marks the fields whose value the pipeline is still going to write', async () => {
    serve({
      ...detail,
      // The AI step is working; the parse is queued behind it.
      steps: { ...detail.steps, analysis: 'RUNNING', markdown: 'PENDING' },
      languages: [],
      country: null,
      city: null,
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));

    // Place comes from the AI step, which is running now.
    const place = screen.getByText(enMessages.viewer.details.place).closest('.legere-definition');
    expect(place?.textContent).toContain('RUNNING');
    // Languages are written by the parse first and the AI step after it; the parse is queued, so
    // the field is not empty-and-final, it is not-yet.
    const languages = screen
      .getByText(enMessages.viewer.details.languages)
      .closest('.legere-definition');
    expect(languages?.textContent).toContain('RUNNING');
    // 🔒 And a value nothing is going to touch says nothing: the badge is about work, not decoration.
    const mime = screen.getByText(enMessages.viewer.details.mime).closest('.legere-definition');
    expect(mime?.textContent).not.toContain('PENDING');
    expect(mime?.textContent).not.toContain('RUNNING');
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
