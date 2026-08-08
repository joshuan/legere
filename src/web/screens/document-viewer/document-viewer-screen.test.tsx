import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetailDto, DocumentFileDto } from '../../../shared/contracts/documents';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentViewerScreen } from './document-viewer-screen';

// The viewer puts the open tab in the address (docs/11 §11.5), so it needs a router.
const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
}));

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CATEGORY_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const LIBRARY_ID = 'cccccccc-3333-4333-8333-333333333333';
const FIRST_FILE = 'ffffffff-1111-4111-8111-111111111111';
const SECOND_FILE = 'ffffffff-2222-4222-8222-222222222222';
const PERSON_ID = 'dddddddd-1111-4111-8111-111111111111';
const SUBJECT_ID = 'dddddddd-2222-4222-8222-222222222222';
const KIND_ID = 'dddddddd-3333-4333-8333-333333333333';

function fileOf(id: string, overrides: Partial<DocumentFileDto> = {}): DocumentFileDto {
  return {
    id,
    position: 0,
    name: 'rental.pdf',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: '2097152',
    origin: 'LIBRARY',
    available: true,
    isImage: false,
    crop: null,
    cropSource: 'NONE',
    refs: [
      { libraryId: LIBRARY_ID, libraryName: 'Invoices', path: 'a/rental.pdf', status: 'HASHED' },
    ],
    // A library file's bytes stay on the volume, so it has no object at all (docs/09 §9.2).
    storageKey: null,
    ...overrides,
  };
}

const detail: DocumentDetailDto = {
  id: ID,
  title: 'Rental agreement',
  fileCount: 1,
  primaryExt: 'pdf',
  sizeBytes: '2097152',
  pageCount: 4,
  documentType: null,
  availability: 'AVAILABLE',
  processing: false,
  origin: 'LIBRARY',
  hasPreview: true,
  createdAt: '2026-01-02T10:00:00.000Z',
  ocrUsed: true,
  description: null,
  titleSource: 'NONE',
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
    canonical: 'DONE',
    preview: 'DONE',
    markdown: 'DONE',
    analysis: 'DONE',
    vectorization: 'SKIPPED',
  },
  processingError: null,
  failedStep: null,
  files: [fileOf(FIRST_FILE)],
  createdBy: null,
};

// A document made of two scans, which is what everything about composition is really about.
const twoFiles: DocumentDetailDto = {
  ...detail,
  fileCount: 2,
  files: [
    fileOf(FIRST_FILE, { name: 'page-1.jpg', ext: 'jpg', mimeType: 'image/jpeg', isImage: true }),
    fileOf(SECOND_FILE, {
      position: 1,
      name: 'page-2.jpg',
      ext: 'jpg',
      mimeType: 'image/jpeg',
      isImage: true,
      refs: [
        {
          libraryId: LIBRARY_ID,
          libraryName: 'Invoices',
          path: 'old/page-2.jpg',
          status: 'MISSING',
        },
      ],
      available: false,
    }),
  ],
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
    // The catalogues the Details form files a document by (docs/03 §3.3.19–20a).
    http.get('/api/people', () =>
      HttpResponse.json(
        envelope({
          items: [{ id: PERSON_ID, name: 'Marija Petrović', note: null, documentCount: 1 }],
        }),
      ),
    ),
    http.get('/api/subjects', () =>
      HttpResponse.json(
        envelope({
          items: [
            {
              id: SUBJECT_ID,
              kindId: KIND_ID,
              kind: 'apartment',
              name: 'Njegoševa 5',
              note: null,
              documentCount: 1,
            },
          ],
        }),
      ),
    ),
    http.get('/api/subject-kinds', () =>
      HttpResponse.json(
        envelope({
          items: [
            { id: KIND_ID, name: 'apartment', note: null, subjectCount: 1, documentCount: 1 },
          ],
        }),
      ),
    ),
    http.get('/api/collections', () => HttpResponse.json(envelope({ items: [] }))),
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
  it('embeds the canonical PDF, whatever the document is made of', async () => {
    // Two photographs, and still a PDF by the time it is readable (docs/05 §5.5, docs/11 §11.5).
    serve(twoFiles);
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    const embed = document.querySelector('object');
    expect(embed).toHaveAttribute('data', `/api/documents/${ID}/canonical`);
    // Both the sidebar button and the <object> fallback hand over the same one piece.
    const downloads = screen.getAllByRole('link', { name: enMessages.viewer.download });
    expect(downloads.length).toBeGreaterThan(0);
    for (const link of downloads) {
      expect(link).toHaveAttribute('href', `/api/documents/${ID}/canonical?download=1`);
    }
  });

  it('says the document is being assembled instead of passing off page one as the whole of it', async () => {
    serve({ ...twoFiles, steps: { ...detail.steps, canonical: 'RUNNING' }, processing: true });
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText(enMessages.viewer.canonical.assembling)).toBeInTheDocument();
    // The first page is honest company for that line; an <object> pointing at a PDF that does not
    // exist yet is a dead embed the browser never retries (docs/10 §10.5).
    expect(document.querySelector('object')).toBeNull();
    expect(document.querySelector('img')).toHaveAttribute('src', `/api/documents/${ID}/preview`);
  });

  it('renders the extracted text, without letting raw HTML through', async () => {
    serve(detail, '# Terms\n\n<script>alert(1)</script>\n\nPlain body');
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.text }));

    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeInTheDocument();
    // 🔒 Extracted text is untrusted content (docs/10 §10.8).
    expect(document.querySelector('script')).toBeNull();
  });

  it('typesets the text rather than dropping it into the browser defaults', async () => {
    serve(detail, '# Terms\n\n| Item | Amount |\n| --- | --- |\n| Rent | 500 |\n\nBody');
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.text }));
    await screen.findByRole('heading', { name: 'Terms' });

    // The pane carries the reading-room typesetting (docs/11 §11.5)…
    expect(document.querySelector('.legere-prose')).not.toBeNull();
    // …and a table gets a scroller of its own, so a wide invoice cannot widen the pane.
    const table = screen.getByRole('table');
    expect(table.parentElement?.className).toContain('legere-prose-table');
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

  it('shows the metadata and what the document is made of', async () => {
    serve(twoFiles);
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));

    expect(await screen.findByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    // One row per file, in page order, each with where its bytes live (docs/11 §11.5a).
    expect(screen.getByText('page-1.jpg')).toBeInTheDocument();
    expect(screen.getByText('Invoices: a/rental.pdf')).toBeInTheDocument();
    expect(screen.getByText('page-2.jpg')).toBeInTheDocument();
    expect(screen.getByText('Invoices: old/page-2.jpg')).toBeInTheDocument();
    // A file the volume has lost is still listed, badged for what it is.
    expect(screen.getByText(enMessages.viewer.files.missing)).toBeInTheDocument();
    // And it says once, quietly, what changing any of this costs.
    expect(screen.getByText(enMessages.viewer.files.rebuildNote)).toBeInTheDocument();
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

  it('saves a person the document names, on its own', async () => {
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

    const people = details.getByRole('combobox', { name: enMessages.viewer.details.people });
    await userEvent.click(people);
    await userEvent.click(await screen.findByTitle('Marija Petrović'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    // 🔒 A person chosen alone is a save of its own: the links are as much of the correction as the
    // documentType is, and Save that quietly does nothing is worse than no Save (docs/11 §11.5).
    await waitFor(() => expect(patched).toEqual({ peopleIds: [PERSON_ID] }));
  });

  it('saves the thing the document is about, on its own', async () => {
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

    const subjects = details.getByRole('combobox', { name: enMessages.viewer.details.subjects });
    await userEvent.click(subjects);
    await userEvent.click(await screen.findByTitle('Njegoševa 5 · apartment'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    await waitFor(() => expect(patched).toEqual({ subjectIds: [SUBJECT_ID] }));
  });

  it('saves the day the document is dated, on its own', async () => {
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

    const date = details.getByRole('textbox', { name: enMessages.viewer.details.documentDate });
    await userEvent.type(date, '2019-03-01{Enter}');
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    // A calendar day travels as the day it is, with no time zone dragged in behind it.
    await waitFor(() => expect(patched).toEqual({ documentDate: '2019-03-01' }));
  });

  it('sends nothing at all when the form was opened and nothing was touched', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );
    // Somebody the document already names, so the links start non-empty and still count as
    // untouched — the order a multi-select puts them in is not an edit.
    serve({
      ...detail,
      people: [{ id: PERSON_ID, name: 'Marija Petrović', deleted: false }],
      subjects: [
        { id: SUBJECT_ID, kindId: KIND_ID, kind: 'apartment', name: 'Njegoševa 5', deleted: false },
      ],
      documentDate: '2019-03-01',
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

    // 🔒 A glance is not an edit: an untouched field must not be sent, or every save would count as
    // a manual assignment of everything (docs/03 §3.3.10).
    expect(patched).toBeNull();
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

  it('offers the name the analysis read under the one the document carries', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(detail));
      }),
    );
    serve({
      ...detail,
      title: 'IMG_20260714_113355',
      auto: { title: 'Rental agreement, Njegoševa 12' },
    });

    renderWithProviders(<DocumentViewerScreen id={ID} />);

    // Under the title, where every other correction keeps its provenance — and one click from
    // being the title (docs/11 §11.5).
    await userEvent.click(
      await screen.findByRole('button', { name: /read as Rental agreement, Njegoševa 12/ }),
    );

    await waitFor(() => expect(patched).toEqual({ reset: ['title'] }));
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

  it('reads an entry whose path was withheld as a sentence, not a dangling dash', async () => {
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(
          envelope({
            items: [
              {
                id: 'eeeeeeee-4444-4444-8444-444444444444',
                type: 'FILE_ATTACHED',
                at: '2026-08-03T10:00:00.000Z',
                actor: null,
                // 🔒 The path of a library file only reaches an admin (docs/03 §3.3.18), so this is
                // what everybody else is served.
                payload: { source: 'LIBRARY' },
              },
            ],
            nextCursor: null,
          }),
        ),
      ),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

    expect(await screen.findByText('Another copy of this document appeared')).toBeInTheDocument();
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

  describe('Download: the document, or what it was made of (docs/11 §11.5b)', () => {
    it('lists the originals under the one piece, one entry per file', async () => {
      serve(twoFiles);
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.viewer.downloadOriginals }),
      );

      const first = await screen.findByRole('link', { name: 'page-1.jpg' });
      expect(first).toHaveAttribute('href', `/api/documents/${ID}/files/${FIRST_FILE}/content`);
      // A file the volume has lost is listed with the reason rather than quietly dropped.
      expect(screen.queryByRole('link', { name: 'page-2.jpg' })).toBeNull();
      expect(screen.getByText(enMessages.viewer.files.missingReason)).toBeInTheDocument();
    });

    it('keeps the originals reachable while the one piece is not built yet', async () => {
      serve({ ...twoFiles, steps: { ...detail.steps, canonical: 'FAILED' } });
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      // 🔒 antd drops the href of a disabled button, so the main half leads nowhere…
      const download = await screen.findByText(enMessages.viewer.download);
      const control = download.closest('a, button');
      expect(control).not.toBeNull();
      expect(control?.getAttribute('href')).toBeNull();

      // …and the dropdown still works, because it is the answer on the worst day (docs/11 §11.5b).
      await userEvent.click(
        screen.getByRole('button', { name: enMessages.viewer.downloadOriginals }),
      );
      expect(await screen.findByRole('link', { name: 'page-1.jpg' })).toBeInTheDocument();
    });
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
    const size = screen.getByText(enMessages.viewer.details.size).closest('.legere-definition');
    expect(size?.textContent).not.toContain('PENDING');
    expect(size?.textContent).not.toContain('RUNNING');
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

  describe('the Files section (docs/11 §11.5a)', () => {
    async function openFiles(document: DocumentDetailDto = twoFiles): Promise<void> {
      serve(document);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      await screen.findByText('page-1.jpg');
    }

    it('sends the whole new order when a file is moved', async () => {
      let reordered: unknown = null;
      server.use(
        http.patch(`/api/documents/${ID}/files`, async ({ request }) => {
          reordered = await request.json();
          return HttpResponse.json(envelope(twoFiles));
        }),
      );
      await openFiles();

      await userEvent.click(screen.getByRole('button', { name: /Move page-2\.jpg up/ }));

      // The complete order, every file exactly once (docs/07 §7.3) — not "this one moved".
      await waitFor(() => expect(reordered).toEqual({ order: [SECOND_FILE, FIRST_FILE] }));
      // The first row cannot go higher, and the last cannot go lower.
      expect(screen.getByRole('button', { name: /Move page-1\.jpg up/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Move page-2\.jpg down/ })).toBeDisabled();
    });

    it('splits a file off into a document of its own', async () => {
      let split = '';
      server.use(
        http.delete(`/api/documents/${ID}/files/:fileId`, ({ params }) => {
          split = String(params.fileId);
          return HttpResponse.json(
            envelope({ document: detail, splitDocumentId: '99999999-9999-4999-8999-999999999999' }),
          );
        }),
      );
      await openFiles();

      const [, second] = screen.getAllByRole('button', {
        name: enMessages.viewer.files.splitOff,
      });
      if (second === undefined) throw new Error('expected a Split off on every row');
      await userEvent.click(second);

      await waitFor(() => expect(split).toBe(SECOND_FILE));
      expect(await screen.findByText(enMessages.viewer.files.splitDone)).toBeInTheDocument();
    });

    it('does not offer to split off the only file a document has', async () => {
      serve(detail);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );

      await screen.findByText('rental.pdf');
      // 🔒 Not offered at all rather than refused after the fact: a document is emptied by deleting
      // it, not by taking its parts away (docs/11 §11.5a).
      expect(screen.queryByRole('button', { name: enMessages.viewer.files.splitOff })).toBeNull();
    });

    it('appends a chosen file to this document rather than making a new one', async () => {
      let appended: string | null = null;
      server.use(
        http.post(`/api/documents/${ID}/files`, ({ request }) => {
          appended = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
          return HttpResponse.json(envelope(twoFiles), { status: 201 });
        }),
      );
      await openFiles();

      const input = document.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
      await userEvent.upload(input, new File(['x'], 'page-3.jpg', { type: 'image/jpeg' }));

      await waitFor(() => expect(appended).toBe('page-3.jpg'));
    });

    // A file's location is answered for every file, not only for the ones lying on a volume: `refs`
    // is empty for a managed file, and the section used to say nothing at all about an upload
    // (docs/09 §9.2, docs/11 §11.5a).
    it('names the object storage and the key for a file that lies on no volume', async () => {
      const key = `files/${FIRST_FILE}/original.jpg`;
      serve({
        ...detail,
        files: [
          fileOf(FIRST_FILE, {
            name: 'scan-01.jpg',
            ext: 'jpg',
            mimeType: 'image/jpeg',
            isImage: true,
            origin: 'MANAGED',
            refs: [],
            storageKey: key,
          }),
        ],
      });
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );

      const line = await screen.findByText(`${enMessages.viewer.files.objectStorage}: ${key}`);
      expect(line).toBeInTheDocument();
      // 🔒 A location, not a way in: the key grants nothing without a signed URL, so it is not
      // dressed up as something to click.
      expect(line.closest('a')).toBeNull();
    });

    it('says nothing about a bucket for a file whose bytes are on a volume', async () => {
      await openFiles();

      // A library file has no object at all (docs/09 §9.2) — its volume and path are its location.
      expect(screen.getByText('Invoices: a/rental.pdf')).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(enMessages.viewer.files.objectStorage))).toBeNull();
    });

    it('opens the crop editor on an image, and offers it on nothing else', async () => {
      await openFiles();

      const [first] = screen.getAllByRole('button', { name: enMessages.viewer.files.crop });
      if (first === undefined) throw new Error('expected a Crop on every image row');
      await userEvent.click(first);

      expect(await screen.findByText(enMessages.viewer.crop.title)).toBeInTheDocument();
    });

    it('offers no crop for a file that is not an image', async () => {
      serve(detail);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );

      await screen.findByText('rental.pdf');
      expect(screen.queryByRole('button', { name: enMessages.viewer.files.crop })).toBeNull();
    });
  });

  // 🔒 The regression this exists for: the selected ids come from the document, which is polled,
  // and the labels came only from the catalogue, which is fetched once when the screen mounts. The
  // analysis creates people and subjects in between, so the editor had no option for them and
  // rc-select fell back to rendering the raw value — a column of UUIDs where names belong.
  describe('names the catalogue has not caught up with', () => {
    it('labels a person the document carries and the catalogue has never heard of', async () => {
      const unknownId = '11111111-2222-4333-8444-555555555555';
      serve({ ...detail, people: [{ id: unknownId, name: 'Ivan Ivanović', deleted: false }] });

      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      const details = within(screen.getByRole('tabpanel'));
      await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

      expect(await details.findByText('Ivan Ivanović')).toBeInTheDocument();
      expect(details.queryByText(unknownId)).toBeNull();
    });

    it('labels a subject the same way, kind and all', async () => {
      const unknownId = '66666666-7777-4888-8999-000000000000';
      serve({
        ...detail,
        subjects: [
          { id: unknownId, kindId: KIND_ID, kind: 'car', name: 'Zastava 750', deleted: false },
        ],
      });

      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      const details = within(screen.getByRole('tabpanel'));
      await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

      expect(await details.findByText('Zastava 750 · car')).toBeInTheDocument();
      expect(details.queryByText(unknownId)).toBeNull();
    });
  });

  // 🔒 A deleted name stays on the documents that name it — 03 §3.3.19, and the confirmation dialog
  // says so to the operator's face. What was missing was any way for a reader to tell such a name
  // from one the catalogue still holds.
  describe('a name the catalogue has let go', () => {
    const goneId = '99999999-8888-4777-8666-555555555555';

    it('strikes it through where the document is read', async () => {
      serve({ ...detail, people: [{ id: goneId, name: 'Petar Petrović', deleted: true }] });

      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );

      const name = await screen.findByText('Petar Petrović');
      expect(name).toHaveStyle({ textDecoration: 'line-through' });
    });

    it('leaves a living name alone', async () => {
      serve({ ...detail, people: [{ id: PERSON_ID, name: 'Marija Petrović', deleted: false }] });

      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );

      const name = await screen.findByText('Marija Petrović');
      expect(name).not.toHaveStyle({ textDecoration: 'line-through' });
    });
  });

  // A kind is not an object, and a detail read on one document is how the next one is found
  // (docs/11 §11.5).
  describe('a kind is not an object, and every name is a way in', () => {
    const CAR_KIND = 'dddddddd-4444-4444-8444-444444444444';
    const SECOND_FLAT = 'dddddddd-5555-4555-8555-555555555555';
    const CAR = 'dddddddd-6666-4666-8666-666666666666';

    // Two flats and a car: several subjects, of more than one kind, on one document.
    const filed: DocumentDetailDto = {
      ...detail,
      documentType: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
      people: [{ id: PERSON_ID, name: 'Marija Petrović', deleted: false }],
      subjects: [
        {
          id: SUBJECT_ID,
          kindId: KIND_ID,
          kind: 'apartment',
          name: 'Njegoševa 5',
          deleted: false,
        },
        {
          id: SECOND_FLAT,
          kindId: KIND_ID,
          kind: 'apartment',
          name: 'Njegoševa 7',
          deleted: false,
        },
        { id: CAR, kindId: CAR_KIND, kind: 'car', name: 'Zastava 750', deleted: false },
      ],
      documentDate: '2019-03-01',
    };

    async function openDetails(document: DocumentDetailDto = filed): Promise<HTMLElement> {
      serve(document);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      return screen.getByRole('tabpanel');
    }

    // The rows are a definition list, so a row is found by the label it is filed under.
    function rowFor(panel: HTMLElement, label: string): HTMLElement {
      const row = within(panel).getByText(label).closest('.legere-definition');
      if (!(row instanceof HTMLElement)) throw new Error(`no row labelled ${label}`);
      return row;
    }

    it('puts the kind and the object on rows of their own instead of one line reading name · kind', async () => {
      const panel = await openDetails();

      const kinds = within(rowFor(panel, enMessages.viewer.details.subjectKinds));
      expect(kinds.getByText('apartment')).toBeInTheDocument();
      expect(kinds.getByText('car')).toBeInTheDocument();

      const objects = within(rowFor(panel, enMessages.viewer.details.subjects));
      expect(objects.getByText('Njegoševa 5')).toBeInTheDocument();
      expect(objects.getByText('Zastava 750')).toBeInTheDocument();
      // The two facts stop being run together where the document is read.
      expect(within(panel).queryByText('Njegoševa 5 · apartment')).toBeNull();
      expect(within(panel).queryByText('Zastava 750 · car')).toBeNull();
    });

    it('names a kind once however many things of it the document is about', async () => {
      const panel = await openDetails();

      const kinds = rowFor(panel, enMessages.viewer.details.subjectKinds);
      // Two flats, and "apartment" said once: the row answers what sort of thing, not how many.
      expect(within(kinds).getAllByText('apartment')).toHaveLength(1);
      expect(kinds.textContent).toContain('apartment, car');
      // Both flats are still there, one row down.
      const objects = within(rowFor(panel, enMessages.viewer.details.subjects));
      expect(objects.getByText('Njegoševa 7')).toBeInTheDocument();
    });

    it('leads from every name to the documents filed under it', async () => {
      const panel = await openDetails();

      const href = (label: string, name: string | RegExp): string | null =>
        within(rowFor(panel, label)).getByRole('link', { name }).getAttribute('href');

      // The facets that already have a browse screen go to it — it resolves its own heading on the
      // server and shows the same card grid (docs/11 §11.4).
      expect(href(enMessages.viewer.details.documentType, 'Contract')).toBe(
        `/browse/types/${CATEGORY_ID}`,
      );
      expect(href(enMessages.viewer.details.people, 'Marija Petrović')).toBe(
        `/browse/people/${PERSON_ID}`,
      );
      expect(href(enMessages.viewer.details.subjects, 'Njegoševa 5')).toBe(
        `/browse/subjects/${KIND_ID}/${SUBJECT_ID}`,
      );
      expect(href(enMessages.viewer.details.documentDate, /2019/)).toBe('/browse/years/2019');

      // The two that have none go to the home screen with the filter in the URL (docs/11 §11.3).
      expect(href(enMessages.viewer.details.subjectKinds, 'car')).toBe(
        `/documents?subjectKindId=${CAR_KIND}`,
      );
      expect(href(enMessages.viewer.details.place, 'Podgorica')).toBe(
        '/documents?country=ME&city=Podgorica',
      );
      expect(href(enMessages.viewer.details.place, 'Montenegro')).toBe('/documents?country=ME');
    });

    it('says an em dash where nothing was detected rather than leaving the row blank', async () => {
      const panel = await openDetails({ ...filed, subjects: [], city: null, country: null });

      // "an em dash where nothing was detected, which is honest and never looks broken"
      // (docs/11 §11.5) — a row of links whose list is empty must not turn that into a blank.
      for (const label of [
        enMessages.viewer.details.subjectKinds,
        enMessages.viewer.details.subjects,
        enMessages.viewer.details.place,
      ]) {
        expect(within(rowFor(panel, label)).getByText('—')).toBeInTheDocument();
      }
    });

    it('leaves a name the catalogue has let go a record rather than a way in', async () => {
      const panel = await openDetails({
        ...filed,
        people: [{ id: PERSON_ID, name: 'Marija Petrović', deleted: true }],
      });

      // Struck through, as 03 §3.3.19 requires — and not a link, because the browse screen resolves
      // its heading from the live catalogue and would answer 404.
      const name = within(panel).getByText('Marija Petrović');
      expect(name).toHaveStyle({ textDecoration: 'line-through' });
      expect(
        within(rowFor(panel, enMessages.viewer.details.people)).queryByRole('link'),
      ).toBeNull();
    });
  });
});
