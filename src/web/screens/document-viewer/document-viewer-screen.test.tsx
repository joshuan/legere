import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentDetailDto,
  DocumentFileDto,
  DocumentFileVersionDto,
  DocumentListDto,
} from '../../../shared/contracts/documents';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
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
const THIRD_FILE = 'ffffffff-5555-4555-8555-555555555555';
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
    rotation: null,
    // The pages as they arrived, and nobody has counted them (docs/03 §3.3.16).
    pageOrder: null,
    pageRotations: null,
    pageCount: null,
    refs: [
      { libraryId: LIBRARY_ID, libraryName: 'Invoices', path: 'a/rental.pdf', status: 'HASHED' },
    ],
    // A library file's bytes stay on the volume, so it has no object at all (docs/09 §9.2).
    storageKey: null,
    // A page nobody has re-photographed has had no other copies (docs/05 §5.6).
    earlierVersions: [],
    ...overrides,
  };
}

// A copy of a page that a better one replaced: in the trash, still readable, hanging off the file
// that took its place (docs/05 §5.6, §5.7a).
function versionOf(
  id: string,
  overrides: Partial<DocumentFileVersionDto> = {},
): DocumentFileVersionDto {
  return {
    id,
    name: 'page-1-scan-1.jpg',
    mimeType: 'image/jpeg',
    ext: 'jpg',
    sizeBytes: '1048576',
    origin: 'MANAGED',
    available: true,
    trashedAt: '2026-02-01T09:00:00.000Z',
    purgeAfter: '2026-03-03T09:00:00.000Z',
    refs: [],
    storageKey: `files/${id}/original.jpg`,
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
  pageFormat: 'AUTO',
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
    fields: 'DONE',
    vectorization: 'SKIPPED',
  },
  processingError: null,
  failedStep: null,
  files: [fileOf(FIRST_FILE)],
  createdBy: null,
  extracted: null,
  extractedSummary: null,
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
  // Which steps the instance is holding (docs/05 §5.4d): none, unless a test is about that.
  pausedSteps: string[] = [],
): void {
  server.use(
    http.get(`/api/documents/${ID}`, () => HttpResponse.json(envelope(document))),
    http.get('/api/pipeline/paused-steps', () => HttpResponse.json(envelope({ pausedSteps }))),
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
          nextCursor: null,
          items: [{ id: PERSON_ID, name: 'Marija Petrović', note: null, documentCount: 1 }],
        }),
      ),
    ),
    http.get('/api/subjects', () =>
      HttpResponse.json(
        envelope({
          nextCursor: null,
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
          nextCursor: null,
          items: [
            { id: KIND_ID, name: 'apartment', note: null, subjectCount: 1, documentCount: 1 },
          ],
        }),
      ),
    ),
    http.get('/api/collections', () => HttpResponse.json(envelope({ items: [] }))),
    // What the Related tab asks for once it is opened (docs/11 §11.5e); nothing linked and nothing
    // proposed is the default, which is the empty state.
    http.get(`/api/documents/${ID}/links`, () => HttpResponse.json(envelope({ items: [] }))),
    http.get(`/api/documents/${ID}/link-suggestions`, () =>
      HttpResponse.json(envelope({ items: [] })),
    ),
    // And what the Log tab asks for, since the processing panel now stands above the history
    // (docs/11 §11.5). A document nothing has happened to yet is the default.
    http.get(`/api/documents/${ID}/events`, () =>
      HttpResponse.json(envelope({ items: [], nextCursor: null })),
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
  it('says where the text is read that some of it was not', async () => {
    serve({ ...detail, auto: { ...detail.auto, textQuality: 'PARTIAL' } }, '# Terms\n\nBody');
    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />, { user: TEST_ADMIN });

    // The verdict was written down and read by nobody: a fact the archive knew and never said.
    // A page this short on a document this full is the one thing a reader cannot tell by looking
    // at what is there (docs/11 §11.5).
    expect(await screen.findByText(enMessages.viewer.textQuality.PARTIAL)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: enMessages.viewer.textQuality.readAgain }),
    ).toBeInTheDocument();
  });

  it('warns about text that is missing entirely, which is the case it exists for', async () => {
    serve({ ...detail, auto: { ...detail.auto, textQuality: 'NONE' } }, null);
    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />, { user: TEST_ADMIN });

    // 🔒 Drawn after the empty state, the warning would never appear on the one document that needs
    // it most: recognition returned nothing, so there is no text for it to stand under.
    expect(await screen.findByText(enMessages.viewer.textQuality.NONE)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: enMessages.viewer.textQuality.readAgain }),
    ).toBeInTheDocument();
  });

  it('carries the extraction mark beside the words of the warning', async () => {
    serve(
      {
        ...detail,
        auto: { ...detail.auto, textQuality: 'PARTIAL', quality: { extraction: 12 } },
      },
      '# Terms\n\nBody',
    );
    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />, { user: TEST_ADMIN });

    // "Some of this document was not read" is a different sentence at 12 out of 100 than at 81,
    // and the reader deciding whether to ask for the re-read is who that difference is for
    // (docs/11 §11.5).
    expect(await screen.findByText(/12\/100/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(enMessages.viewer.textQuality.PARTIAL))).toBeInTheDocument();
  });

  it('says the words alone where the analysis gave no mark', async () => {
    serve({ ...detail, auto: { ...detail.auto, textQuality: 'PARTIAL' } }, '# Terms\n\nBody');
    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />, { user: TEST_ADMIN });

    // 🔒 A missing mark is not a zero: nothing is drawn where nothing was answered, least of all a
    // nought (docs/03 §3.3.18).
    expect(await screen.findByText(enMessages.viewer.textQuality.PARTIAL)).toBeInTheDocument();
    expect(screen.queryByText(/\/100/)).toBeNull();
  });

  it('says nothing about the text when the model found nothing wrong with it', async () => {
    serve({ ...detail, auto: { ...detail.auto, textQuality: 'GOOD' } }, '# Terms\n\nBody');
    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />, { user: TEST_ADMIN });

    await screen.findByText('Terms');
    expect(screen.queryByText(enMessages.viewer.textQuality.PARTIAL)).not.toBeInTheDocument();
  });

  it('offers the re-read only to somebody who may ask for one', async () => {
    serve({ ...detail, auto: { ...detail.auto, textQuality: 'NONE' } }, '# Terms\n\nBody');
    renderWithProviders(<DocumentViewerScreen id={ID} tab="text" />);

    // The warning is for everybody — it is a fact about the document. The button is a request to
    // spend the pipeline, which is an admin's to make (docs/07 §7.3).
    expect(await screen.findByText(enMessages.viewer.textQuality.NONE)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enMessages.viewer.textQuality.readAgain }),
    ).not.toBeInTheDocument();
  });

  it('says on the details tab what each step cost', async () => {
    serve(detail);
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(
          envelope({
            items: [
              {
                id: 'eeeeeeee-9999-4999-8999-999999999999',
                type: 'STEP_FINISHED',
                at: '2026-08-12T10:00:00.000Z',
                actor: null,
                payload: { step: 'markdown', status: 'DONE', durationMs: 4200, chars: 1200 },
              },
            ],
            nextCursor: null,
          }),
        ),
      ),
    );
    renderWithProviders(<DocumentViewerScreen id={ID} tab="details" />);

    // The log has one line per moment; the details answer the same numbers per step, which is how
    // the question is actually asked (docs/11 §11.5).
    expect(await screen.findByText(enMessages.viewer.details.cost)).toBeInTheDocument();
    expect(screen.getByText(/1200/)).toBeInTheDocument();
  });

  it('draws each mark beside the other numbers of the step that answered it, out of a hundred', async () => {
    serve(detail);
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(
          envelope({
            items: [
              {
                id: 'eeeeeeee-1111-4111-8111-111111111111',
                type: 'STEP_FINISHED',
                at: '2026-08-12T10:02:00.000Z',
                actor: null,
                payload: {
                  step: 'fields',
                  status: 'DONE',
                  durationMs: 900,
                  confidence: 78,
                },
              },
              {
                id: 'eeeeeeee-2222-4222-8222-222222222222',
                type: 'STEP_FINISHED',
                at: '2026-08-12T10:01:00.000Z',
                actor: null,
                payload: {
                  step: 'analysis',
                  status: 'DONE',
                  durationMs: 3100,
                  promptTokens: 900,
                  completionTokens: 40,
                  legibility: 20,
                  extraction: 95,
                },
              },
              {
                id: 'eeeeeeee-3333-4333-8333-333333333333',
                type: 'STEP_FINISHED',
                at: '2026-08-12T10:00:00.000Z',
                actor: null,
                // A step that answers no mark, which is most of them: nothing out of a hundred
                // stands in its row.
                payload: { step: 'markdown', status: 'DONE', durationMs: 4200, chars: 1200 },
              },
            ],
            nextCursor: null,
          }),
        ),
      ),
    );
    renderWithProviders(<DocumentViewerScreen id={ID} tab="details" />);

    const heading = await screen.findByRole('heading', { name: enMessages.viewer.details.cost });
    const section = heading.closest('.ant-space-vertical');
    if (!(section instanceof HTMLElement)) throw new Error('expected the What it cost section');
    const rowOf = (step: string): HTMLElement => {
      const label = within(section).getByText(step);
      const row = label.parentElement;
      if (!(row instanceof HTMLElement)) throw new Error(`expected the ${step} row`);
      return row;
    };

    // Each mark beside the numbers of the step that answered it, as a score of the reading rather
    // than a fourth measurement of the document (docs/11 §11.5).
    expect(rowOf(enMessages.viewer.steps.analysis).textContent).toContain('20/100');
    expect(rowOf(enMessages.viewer.steps.analysis).textContent).toContain('95/100');
    expect(rowOf(enMessages.viewer.steps.fields).textContent).toContain('78/100');
    // 🔒 And nothing out of a hundred where the step answered nothing: a missing mark is not a zero.
    expect(rowOf(enMessages.viewer.steps.markdown).textContent).not.toContain('/100');
  });

  // The tabs are the one strip of chrome the document's own column spends, and the document's name
  // stands in the panel of things *about* it (docs/11 §11.5).
  describe('the chrome above the document, and the name beside it', () => {
    it('renders no heading above the tabs row in the main column', async () => {
      serve({ ...detail, description: 'A lease on Njegoševa 5.' });
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      const tabs = await screen.findByRole('tablist');
      const main = tabs.closest('.ant-col');
      if (!(main instanceof HTMLElement)) throw new Error('expected the main column');

      // 🔒 Nothing whatever above them: the tabs are the first thing the column draws, so the open
      // tab takes the rest of the height the viewport has.
      expect(main.firstElementChild?.contains(tabs)).toBe(true);
      expect(within(main).queryByText(detail.title)).toBeNull();
      expect(within(main).queryByText('A lease on Njegoševa 5.')).toBeNull();

      // 🔒 And exactly one of each on the screen: a name in two places is a name somebody edits in
      // the wrong one.
      expect(screen.getAllByText(detail.title)).toHaveLength(1);
      expect(screen.getAllByText('A lease on Njegoševa 5.')).toHaveLength(1);
    });

    it('draws no frame around the document — no card, no border, no padding of its own', async () => {
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      const tabs = await screen.findByRole('tablist');
      const main = tabs.closest('.ant-col');
      if (!(main instanceof HTMLElement)) throw new Error('expected the main column');

      // 🔒 The argument above, in width rather than in height: a frame around the whole zone is a
      // frame around the one thing the screen exists to show (docs/11 §11.5).
      expect(main.querySelector('.ant-card')).toBeNull();
      // The panel beside it keeps its cards, because those are objects laid on a page.
      const side = screen.getByText(detail.title).closest('.ant-col');
      expect(side).not.toBe(main);
      expect(side?.querySelector('.ant-card')).not.toBeNull();
    });

    it('hangs the height chain on the row and its two columns, so the tab can take the rest', async () => {
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      const tabs = await screen.findByRole('tablist');
      const main = tabs.closest('.ant-col');
      if (!(main instanceof HTMLElement)) throw new Error('expected the main column');

      // The chain the stylesheet hangs the viewport height from (docs/11 §11.5): the row, the column
      // the document is in, and the panel that scrolls beside it. jsdom computes no layout, so what
      // is asserted here is that every link of it is present and named.
      const row = main.parentElement;
      expect(main).toHaveClass('legere-viewer-main');
      expect(row).toHaveClass('legere-viewer');
      expect(row?.querySelector('.legere-viewer-side')).not.toBeNull();
      // And the tabs are that column's own child, with nothing in between to break the chain.
      expect(main.firstElementChild).toHaveClass('ant-tabs');

      // 🔒 The vertical inset of this screen is the stylesheet's to give away — the row takes the
      // top and bottom edges of the window with a negative margin, which an inline one would fight
      // and win (docs/11 §11.5). The gutter antd writes inline is the horizontal one, and it stays.
      if (!(row instanceof HTMLElement)) throw new Error('expected the row');
      expect(row.style.marginTop).toBe('');
      expect(row.style.marginBottom).toBe('');
      expect(row.style.marginLeft).not.toBe('');
    });

    it('gives the canonical the height of its pane rather than a fixed slice of the window', async () => {
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      const object = await screen.findByLabelText(enMessages.viewer.tabs.preview, {
        selector: 'object',
      });
      // 🔒 The bug this replaces: a hard 70vh left the document ending well above the foot of the
      // window with dead space under it (docs/11 §11.5).
      expect(object).toHaveClass('legere-viewer-preview');
      expect(object.getAttribute('style')).toBeNull();
    });

    it('edits the title in place from the sidebar, saving through the same PATCH', async () => {
      let patched: unknown = null;
      server.use(
        http.patch(`/api/documents/${ID}`, async ({ request }) => {
          patched = await request.json();
          return HttpResponse.json(envelope(detail));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      // A click on the text, not a form: the name is written here and corrected nowhere else.
      await userEvent.click(await screen.findByText(detail.title));
      const input = screen.getByRole('textbox');
      expect(input).toHaveValue(detail.title);
      await userEvent.clear(input);
      await userEvent.type(input, 'Lease, Njegoševa 5');
      // Leaving the field commits it, the same as pressing Enter in it.
      await userEvent.tab();

      await waitFor(() => expect(patched).toEqual({ title: 'Lease, Njegoševa 5' }));
    });

    it('writes a description from the em dash standing in for the one nobody has written', async () => {
      let patched: unknown = null;
      server.use(
        http.patch(`/api/documents/${ID}`, async ({ request }) => {
          patched = await request.json();
          return HttpResponse.json(envelope(detail));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      // Drawn as an em dash rather than left out — a blank reads as a rendering bug — and the dash
      // is what there is to click on to write one (docs/11 §11.5).
      await userEvent.click(await screen.findByText('—'));
      const input = screen.getByRole('textbox');
      expect(input).toHaveValue('');
      await userEvent.type(input, 'A lease on Njegoševa 5.');
      await userEvent.tab();

      await waitFor(() => expect(patched).toEqual({ description: 'A lease on Njegoševa 5.' }));
    });

    it('types an "e" into the title rather than opening the Details editor', async () => {
      renderWithProviders(<DocumentViewerScreen id={ID} tab="details" />);

      // The Details pane is what listens for E, so it has to be on screen for the guard to be worth
      // anything — its listener is on the window and hears the sidebar too.
      await screen.findByRole('button', { name: enMessages.common.actions.edit });
      await userEvent.click(screen.getByText(detail.title));
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'E');

      // 🔒 A bare letter that opens a form while somebody is writing a title is a bare letter that
      // eats the title (docs/11 §11.5).
      expect(input).toHaveValue(`${detail.title}E`);
      expect(
        within(screen.getByRole('tabpanel')).queryByRole('textbox', {
          name: enMessages.viewer.details.city,
        }),
      ).toBeNull();
    });
  });

  it('shows the page itself beside what may be done with it', async () => {
    serve(detail);
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText(detail.title)).toBeInTheDocument();
    // "Is this the right document" is a glance, not a read: the small one sits between the actions
    // and the pipeline, the readable copy stays the pane on the left (docs/11 §11.5).
    const previews = document.querySelectorAll(`img[src*="/${ID}/preview"]`);
    expect(previews.length).toBeGreaterThan(0);
  });

  it('embeds the canonical PDF, whatever the document is made of', async () => {
    // Two photographs, and still a PDF by the time it is readable (docs/05 §5.5, docs/11 §11.5).
    serve(twoFiles);
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    const embed = document.querySelector('object');
    expect(embed).toHaveAttribute('data', `/api/documents/${ID}/canonical`);
    // Whatever hands the document over — here the <object>'s own fallback — hands over the one
    // piece; the split button that does the same is on the Files tab (docs/11 §11.5a).
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

  it('shows the metadata, and leaves what the document is made of to the Files tab', async () => {
    serve(twoFiles);
    renderWithProviders(<DocumentViewerScreen id={ID} />);

    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));

    expect(await screen.findByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    // The composition is a tab of its own now (docs/11 §11.5a), so it is not underneath the
    // metadata: what a document is made of is a different question from what it is about.
    expect(screen.queryByText('page-1.jpg')).toBeNull();
    expect(screen.queryByText(enMessages.viewer.files.rebuildNote)).toBeNull();
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

  it('warns that a new page format waits for the next processing, and saves it as a plain field', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/documents/${ID}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...detail, pageFormat: 'A4' }));
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} />);
    await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }));
    const details = within(screen.getByRole('tabpanel'));
    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

    // Nothing is said until the choice actually differs: opening the form to change the city must not
    // lecture anybody about page shapes (docs/11 §11.5).
    expect(
      details.queryByText(enMessages.viewer.details.pageFormatRebuild),
    ).not.toBeInTheDocument();

    const format = details.getByRole('combobox', { name: enMessages.viewer.details.pageFormat });
    await userEvent.click(format);
    await userEvent.click(await screen.findByTitle(enMessages.viewer.details.pageFormats.A4));

    // 🔒 Said where it is being decided: the format is read while the pages are made, and they are
    // made already, so the pages keep their shape until the document is processed again.
    expect(await details.findByText(enMessages.viewer.details.pageFormatRebuild)).toBeVisible();

    await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));
    await waitFor(() => expect(patched).toEqual({ pageFormat: 'A4' }));
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

  it('folds a run under its queue entry, one line per step', async () => {
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(
          envelope({
            items: [
              {
                id: 'eeeeeeee-5555-4555-8555-555555555555',
                type: 'STEP_FINISHED',
                at: '2026-08-03T11:00:10.000Z',
                actor: null,
                payload: {
                  step: 'markdown',
                  status: 'DONE',
                  durationMs: 4200,
                  chars: 1200,
                  service: 'docling',
                  requestId: 'aaaaaaaa-9999-4999-8999-999999999999',
                },
              },
              {
                id: 'eeeeeeee-6666-4666-8666-666666666666',
                type: 'STEP_STARTED',
                at: '2026-08-03T11:00:00.000Z',
                actor: null,
                payload: {
                  step: 'markdown',
                  service: 'docling',
                  requestId: 'aaaaaaaa-9999-4999-8999-999999999999',
                },
              },
              {
                id: 'eeeeeeee-7777-4777-8777-777777777777',
                type: 'QUEUED',
                at: '2026-08-03T10:59:00.000Z',
                actor: 'Admin',
                payload: { steps: ['markdown'] },
              },
            ],
            nextCursor: null,
          }),
        ),
      ),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

    // The run's head says who asked and for what…
    expect(await screen.findByText(/Queued: Text/)).toBeInTheDocument();
    expect(screen.getByText(/Admin/)).toBeInTheDocument();
    // …and the started and the settled event are one line wearing the verdict and the cost
    // together, not two rows (docs/11 §11.5).
    expect(screen.getByText('Done · 4.2 s · 1200 characters')).toBeInTheDocument();
    // The pair's one requestId is written once, with the service that did the work.
    expect(screen.getAllByText(/docling/)).toHaveLength(1);
  });

  it('tells a severed pair from a live one honestly', async () => {
    // A started event whose settled half never came, on a document the pipeline has moved past:
    // an outage severed the pair (docs/05 §5.4e), and the line says so instead of pretending.
    const orphan = [
      {
        id: 'eeeeeeee-6666-4666-8666-666666666666',
        type: 'STEP_STARTED',
        at: '2026-08-03T11:00:00.000Z',
        actor: null,
        payload: { step: 'markdown', service: 'docling' },
      },
      {
        id: 'eeeeeeee-7777-4777-8777-777777777777',
        type: 'QUEUED',
        at: '2026-08-03T10:59:00.000Z',
        actor: null,
        payload: { steps: ['markdown'] },
      },
    ];
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(envelope({ items: orphan, nextCursor: null })),
      ),
    );

    const severed = renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);
    expect(
      await screen.findByText(new RegExp(enMessages.viewer.stepStatus.INTERRUPTED)),
    ).toBeInTheDocument();
    severed.unmount();

    // The same orphan while the pipeline is on that very step is not severed — it is running now.
    serve({ ...detail, processing: true, steps: { ...detail.steps, markdown: 'RUNNING' } });
    server.use(
      http.get(`/api/documents/${ID}/events`, () =>
        HttpResponse.json(envelope({ items: orphan, nextCursor: null })),
      ),
    );
    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);
    await screen.findByText(/Queued: Text/);
    const journal = window.document.querySelector('.legere-journal');
    if (!(journal instanceof HTMLElement)) throw new Error('expected the journal');
    expect(within(journal).getByText(enMessages.viewer.stepStatus.RUNNING)).toBeInTheDocument();
  });

  it('offers more history while the server holds more', async () => {
    server.use(
      http.get(`/api/documents/${ID}/events`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === 'older') {
          return HttpResponse.json(
            envelope({
              items: [
                {
                  id: 'eeeeeeee-8888-4888-8888-888888888888',
                  type: 'CREATED',
                  at: '2026-08-01T10:00:00.000Z',
                  actor: null,
                  payload: {},
                },
              ],
              nextCursor: null,
            }),
          );
        }
        return HttpResponse.json(
          envelope({
            items: [
              {
                id: 'eeeeeeee-3333-4333-8333-333333333333',
                type: 'META_CHANGED',
                at: '2026-08-03T12:00:00.000Z',
                actor: 'Admin',
                payload: { changes: { city: { from: 'Podgorica', to: 'Bar' } } },
              },
            ],
            nextCursor: 'older',
          }),
        );
      }),
    );

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

    // 🔒 The first page arrived with more held back, and the foot says so instead of passing the
    // page boundary off as the beginning of time (docs/11 §11.5).
    expect(await screen.findByText(/City: Podgorica → Bar/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.log.showMore }));

    // The older page joins under the newer one — and nothing older is left, so the button goes.
    expect(await screen.findByText(enMessages.viewer.log.createdBare)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: enMessages.viewer.log.showMore }),
      ).not.toBeInTheDocument(),
    );
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
    // It stands at the head of the Files tab now: "the document as one piece", "one of the
    // originals" and "these are the originals" are three answers to one question (docs/11 §11.5a).
    async function openFiles(document: DocumentDetailDto = twoFiles): Promise<void> {
      serve(document);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }));
      await screen.findByText('page-1.jpg');
    }

    it('lists the originals under the one piece, one entry per file', async () => {
      await openFiles();

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
      await openFiles({ ...twoFiles, steps: { ...detail.steps, canonical: 'FAILED' } });

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

    // 🔒 The whole file list stands between them, which is the only thing that makes it safe to put
    // a download and a deletion in one tab (docs/11 §11.5d).
    it('keeps the length of the list between Download and Delete', async () => {
      serve(twoFiles);
      renderWithProviders(<DocumentViewerScreen id={ID} />, { user: TEST_ADMIN });
      await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }));
      await screen.findByText('page-1.jpg');

      // Scoped to the tab: the preview pane behind it carries the <object>'s own fallback link,
      // which says the same words.
      const panel = screen.getByRole('tabpanel');
      // An `a` while the canonical is ready, a `button` while it is not (docs/11 §11.5b).
      const download = within(panel).getByText(enMessages.viewer.download).closest('a, button');
      const list = panel.querySelector('.ant-list');
      const remove = screen.getByRole('button', { name: enMessages.viewer.delete.action });
      if (download === null || list === null) throw new Error('expected Download above the list');

      const follows = (before: Element, after: Element): boolean =>
        (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      expect(follows(download, list)).toBe(true);
      expect(follows(list, remove)).toBe(true);
    });
  });

  it('shows the per-step states and the error behind a failure', async () => {
    serve({
      ...detail,
      steps: { ...detail.steps, preview: 'FAILED' },
      processingError: 'Stirling failed with 500',
      failedStep: 'preview',
    });

    // The panel stands at the head of the Log tab now, above the history of the same work
    // (docs/11 §11.5).
    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

    expect(await screen.findByText(enMessages.viewer.processing.title)).toBeInTheDocument();
    // In the reader's own words, not the schema's (docs/11 §11.5).
    expect(screen.getByText(enMessages.viewer.stepStatus.FAILED)).toBeInTheDocument();
    // 🔒 Under the step that failed, not at the bottom of the card: an error that names no step is
    // an error nobody can act on (docs/11 §11.5).
    const failed = screen.getByText('Stirling failed with 500');
    expect(failed.closest('.legere-step')?.textContent).toContain(enMessages.viewer.steps.preview);
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

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

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

    // Place comes from the AI step, which is running now. The badge speaks the reader's language,
    // the same words the processing panel uses (docs/11 §11.5).
    const place = screen.getByText(enMessages.viewer.details.place).closest('.legere-definition');
    expect(place?.textContent).toContain(enMessages.viewer.stepStatus.RUNNING);
    // Languages are written by the parse first and the AI step after it; the parse is queued, so
    // the field is not empty-and-final, it is not-yet.
    const languages = screen
      .getByText(enMessages.viewer.details.languages)
      .closest('.legere-definition');
    expect(languages?.textContent).toContain(enMessages.viewer.stepStatus.RUNNING);
    // 🔒 And a value nothing is going to touch says nothing: the badge is about work, not decoration.
    const size = screen.getByText(enMessages.viewer.details.size).closest('.legere-definition');
    expect(size?.textContent).not.toContain(enMessages.viewer.stepStatus.PENDING);
    expect(size?.textContent).not.toContain(enMessages.viewer.stepStatus.RUNNING);
  });

  it('offers reprocessing to an admin only, with the chosen steps', async () => {
    let body: unknown = null;
    server.use(
      http.post(`/api/documents/${ID}/reprocess`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(envelope({ documentId: ID, steps: ['preview'] }), { status: 201 });
      }),
    );

    const asUser = renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);
    expect(await screen.findByText(enMessages.viewer.processing.title)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enMessages.viewer.processing.reprocessAll }),
    ).not.toBeInTheDocument();
    asUser.unmount();

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />, { user: TEST_ADMIN });
    await screen.findByText(enMessages.viewer.processing.title);
    // Scoped to the tab, which now holds the panel and the history both (docs/11 §11.5).
    const panel = within(screen.getByRole('tabpanel'));

    // At rest the panel is a status instrument: the checkboxes appear when steps are being chosen
    // and not before (docs/11 §11.5).
    expect(panel.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(
      panel.getByRole('button', { name: enMessages.viewer.processing.chooseSteps }),
    );
    await userEvent.click(panel.getByRole('checkbox', { name: enMessages.viewer.steps.preview }));
    await userEvent.click(panel.getByRole('button', { name: 'Reprocess 1 step' }));

    await waitFor(() => expect(body).toEqual({ steps: ['preview'] }));
  });

  // A step the instance is holding (docs/05 §5.4d): PENDING on purpose, which is a different answer
  // from "the queue is slow" and is owed to whoever opened the document (docs/11 §11.5).
  it('says a step is paused, to every reader, and lets nobody select it for a re-run', async () => {
    serve({ ...detail, steps: { ...detail.steps, analysis: 'PENDING' } }, null, ['analysis']);

    const asUser = renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);
    await screen.findByText(enMessages.viewer.processing.title);
    // Not an admin's fact: the reader is told why the document has been half processed for days.
    expect(await screen.findByText(enMessages.viewer.processing.pausedTag)).toBeInTheDocument();
    expect(screen.getByText(enMessages.viewer.processing.pausedHint)).toBeInTheDocument();
    asUser.unmount();

    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />, { user: TEST_ADMIN });
    await screen.findByText(enMessages.viewer.processing.title);
    const panel = within(screen.getByRole('tabpanel'));

    // 🔒 The server refuses to run a held step, so the checkbox that would ask for it is not
    // offered — the one beside a step that runs still is.
    await userEvent.click(
      panel.getByRole('button', { name: enMessages.viewer.processing.chooseSteps }),
    );
    await waitFor(() =>
      expect(
        panel.getByRole('checkbox', { name: enMessages.viewer.steps.analysis }),
      ).toBeDisabled(),
    );
    expect(panel.getByRole('checkbox', { name: enMessages.viewer.steps.preview })).toBeEnabled();
  });

  // Two sections, in that order: "is it finished, and did anything break", then "what happened"
  // (docs/11 §11.5).
  it('puts what is being done to the document above what has been done to it', async () => {
    serve(detail);
    renderWithProviders(<DocumentViewerScreen id={ID} tab="log" />);

    const processing = await screen.findByText(enMessages.viewer.processing.title);
    const history = screen.getByText(enMessages.viewer.log.history);
    expect(
      processing.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // And neither of them repeats the word on the tab.
    expect(processing.textContent).not.toBe(enMessages.viewer.tabs.log);
    expect(history.textContent).not.toBe(enMessages.viewer.tabs.log);
  });

  // 🔒 The one control that destroys anything (docs/11 §11.5d). What is tested here is that nobody
  // reaches it by accident and that the modal says what will happen before it does.
  describe('deleting a document (docs/11 §11.5d)', () => {
    // At the foot of the Files tab now: a deletion is a decision about the bytes, and the modal's
    // inventory counts the very rows above it (docs/11 §11.5d).
    it('is offered to an admin and to nobody else', async () => {
      const asUser = renderWithProviders(<DocumentViewerScreen id={ID} tab="files" />);
      expect(await screen.findByText('rental.pdf')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: enMessages.viewer.delete.action }),
      ).not.toBeInTheDocument();
      asUser.unmount();

      renderWithProviders(<DocumentViewerScreen id={ID} tab="files" />, { user: TEST_ADMIN });

      expect(
        await screen.findByRole('button', { name: enMessages.viewer.delete.action }),
      ).toBeInTheDocument();
    });

    it('deletes nothing until the confirmation is answered', async () => {
      let deleted = false;
      server.use(
        http.delete(`/api/documents/${ID}`, () => {
          deleted = true;
          return HttpResponse.json(envelope({ ok: true }));
        }),
      );
      serve(twoFiles);
      renderWithProviders(<DocumentViewerScreen id={ID} tab="files" />, { user: TEST_ADMIN });

      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.viewer.delete.action }),
      );

      // The button opened a question, not a deletion.
      expect(deleted).toBe(false);
      const dialog = within(await screen.findByRole('dialog'));
      // What goes: the document and the files it is made of, counted and weighed.
      expect(dialog.getByText(/2 files/)).toBeInTheDocument();
      expect(dialog.getByText(/2\.0 MB/)).toBeInTheDocument();
      // What stays, which is the part nobody can infer: the volume is read-only.
      expect(dialog.getByText(/will not be deleted/)).toBeInTheDocument();
      expect(dialog.getByText(enMessages.viewer.delete.forGood)).toBeInTheDocument();

      await userEvent.click(dialog.getByRole('button', { name: enMessages.viewer.delete.action }));

      await waitFor(() => expect(deleted).toBe(true));
      // The address the document lived at no longer resolves, so the reader is not left on it.
      await waitFor(() => expect(push).toHaveBeenCalledWith('/documents'));
    });

    it('says nothing about kept originals for a document made only of uploads', async () => {
      serve({
        ...detail,
        files: [fileOf(FIRST_FILE, { origin: 'MANAGED', refs: [], storageKey: 'files/x/a.pdf' })],
      });
      renderWithProviders(<DocumentViewerScreen id={ID} tab="files" />, { user: TEST_ADMIN });

      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.viewer.delete.action }),
      );

      // There is no original on a volume to keep, and a modal that says so anyway is read past.
      const dialog = within(await screen.findByRole('dialog'));
      expect(dialog.queryByText(/will not be deleted/)).toBeNull();
    });
  });

  describe('the Files tab (docs/11 §11.5a)', () => {
    async function openFiles(document: DocumentDetailDto = twoFiles): Promise<void> {
      serve(document);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }));
      await screen.findByText('page-1.jpg');
    }

    // Replace opens the picker on the row it will stand in for, so the input rc-upload hides is the
    // one inside that row rather than the Add-files one above the list.
    function pickerOn(name: string): HTMLInputElement {
      const row = screen.getByText(name).closest('li');
      const input = row?.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error(`no picker on the ${name} row`);
      return input;
    }

    // The block of earlier versions, found by the summary that opens it.
    function versionsBlock(label: RegExp): HTMLElement {
      const block = screen.getByText(label).closest('.ant-collapse');
      if (!(block instanceof HTMLElement)) throw new Error('no earlier-versions block');
      return block;
    }

    it('lists what the document is made of, one row per file', async () => {
      await openFiles();

      // One row per file, in page order, each with where its bytes live (docs/11 §11.5a).
      expect(screen.getByText('Invoices: a/rental.pdf')).toBeInTheDocument();
      expect(screen.getByText('page-2.jpg')).toBeInTheDocument();
      expect(screen.getByText('Invoices: old/page-2.jpg')).toBeInTheDocument();
      // A file the volume has lost is still listed, badged for what it is.
      expect(screen.getByText(enMessages.viewer.files.missing)).toBeInTheDocument();
      // And it says once, quietly, what changing any of this costs.
      expect(screen.getByText(enMessages.viewer.files.rebuildNote)).toBeInTheDocument();
    });

    // The composition has an address of its own, which is what makes "the pages are in the wrong
    // order" a link somebody can be sent (docs/11 §11.5, §11.5a).
    it('puts the tab in the address', async () => {
      await openFiles();

      expect(replace).toHaveBeenCalledWith(`/documents/${ID}/files`);
    });

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
      await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }));

      await screen.findByText('rental.pdf');
      // 🔒 Not offered at all rather than refused after the fact: a document is emptied by deleting
      // it, not by taking its parts away (docs/11 §11.5a).
      expect(screen.queryByRole('button', { name: enMessages.viewer.files.splitOff })).toBeNull();
    });

    it('appends a chosen file to this document, and lists it only once it has landed', async () => {
      let appended: string | null = null;
      let release: () => void = () => {};
      await openFiles();

      const threeFiles: DocumentDetailDto = {
        ...twoFiles,
        fileCount: 3,
        files: [
          ...twoFiles.files,
          fileOf(THIRD_FILE, {
            position: 2,
            name: 'page-3.jpg',
            ext: 'jpg',
            mimeType: 'image/jpeg',
            isImage: true,
          }),
        ],
      };
      // Registered after the tab was opened, so it answers ahead of the one `openFiles` put up.
      server.use(
        http.get(`/api/documents/${ID}`, () =>
          HttpResponse.json(envelope(appended === null ? twoFiles : threeFiles)),
        ),
        http.post(`/api/documents/${ID}/files`, async ({ request }) => {
          appended = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return HttpResponse.json(envelope(threeFiles), { status: 201 });
        }),
      );

      // The Add-files picker, which is the one above the list rather than a row's own Replace.
      const input = document.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('no file input rendered');
      await userEvent.upload(input, new File(['x'], 'page-3.jpg', { type: 'image/jpeg' }));

      await waitFor(() => expect(appended).toBe('page-3.jpg'));
      // 🔒 The list holds real files only: a file on its way is watched in the upload panel, so
      // nothing in the composition is a row that might yet turn out not to exist (docs/11 §11.5a).
      expect(screen.queryByText('page-3.jpg')).toBeNull();

      release();
      // And the row appears as the file lands and the document is re-fetched under it.
      expect(await screen.findByText('page-3.jpg')).toBeInTheDocument();
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
      await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }));

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
      await userEvent.click(await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }));

      await screen.findByText('rental.pdf');
      expect(screen.queryByRole('button', { name: enMessages.viewer.files.crop })).toBeNull();
    });

    // The pages inside one file, arranged on the row that holds it (docs/11 §11.5a).
    describe('arranging the pages of one file', () => {
      const PAGES = enMessages.viewer.files.pages;

      // A PDF a build has been through: three pages counted, standing as they arrived.
      const threePages: DocumentDetailDto = {
        ...detail,
        files: [fileOf(FIRST_FILE, { name: 'lease.pdf', pageCount: 3 })],
      };

      const pageThumbs = (): string[] =>
        [...globalThis.document.querySelectorAll('img')]
          .map((image) => image.getAttribute('src') ?? '')
          .filter((src) => src.includes('/pages/'));

      const tile = (page: number, position: number): HTMLElement =>
        screen.getByRole('button', {
          name: PAGES.page
            .replace('{page}', String(page))
            .replace('{position}', String(position))
            .replace('{total}', '3'),
        });

      async function openPages(document: DocumentDetailDto = threePages): Promise<void> {
        serve(document);
        renderWithProviders(<DocumentViewerScreen id={ID} />);
        await userEvent.click(
          await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }),
        );
        await screen.findByText('lease.pdf');
      }

      it('opens the row into a strip of its pages, and asks for no thumbnail before that', async () => {
        await openPages();

        // Opening the tab costs nothing for the rows nobody expands (docs/11 §11.5a).
        expect(pageThumbs()).toEqual([]);

        await userEvent.click(screen.getByRole('button', { name: PAGES.arrange }));

        expect(screen.getByTestId('page-strip')).toBeInTheDocument();
        expect(pageThumbs()).toEqual([
          `/api/documents/${ID}/files/${FIRST_FILE}/pages/0/thumb`,
          `/api/documents/${ID}/files/${FIRST_FILE}/pages/1/thumb`,
          `/api/documents/${ID}/files/${FIRST_FILE}/pages/2/thumb`,
        ]);

        // And it closes again from the same control.
        await userEvent.click(screen.getByRole('button', { name: PAGES.arrange }));
        expect(screen.queryByTestId('page-strip')).toBeNull();
      });

      // 🔒 The strip never renders for a file that has no pages to arrange (docs/11 §11.5a).
      it('offers nothing to arrange on a file whose pages no build has counted', async () => {
        serve(detail);
        renderWithProviders(<DocumentViewerScreen id={ID} />);
        await userEvent.click(
          await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }),
        );

        await screen.findByText('rental.pdf');
        expect(screen.queryByRole('button', { name: PAGES.arrange })).toBeNull();
        expect(screen.queryByTestId('page-strip')).toBeNull();
      });

      it('offers nothing to arrange on a single-page file or on an image', async () => {
        await openFiles({
          ...twoFiles,
          files: [
            fileOf(FIRST_FILE, {
              name: 'page-1.jpg',
              ext: 'jpg',
              mimeType: 'image/jpeg',
              isImage: true,
              pageCount: 4,
            }),
            fileOf(SECOND_FILE, { position: 1, name: 'page-2.pdf', pageCount: 1 }),
          ],
        });

        // A photograph has no pages, whatever a count says; one page is not an order.
        expect(screen.queryByRole('button', { name: PAGES.arrange })).toBeNull();
      });

      // 🔒 The keyboard path end to end, from the row to the request: a hit area only a mouse can
      // use is half a fix (docs/11 §11.3, §11.5a).
      it('moves a page with the arrow keys and saves the whole permutation', async () => {
        let sent: unknown = null;
        server.use(
          http.patch(`/api/documents/${ID}/files/${FIRST_FILE}`, async ({ request }) => {
            sent = await request.json();
            return HttpResponse.json(envelope(threePages));
          }),
        );
        await openPages();
        await userEvent.click(screen.getByRole('button', { name: PAGES.arrange }));

        await userEvent.click(tile(1, 1));
        await userEvent.keyboard('{ArrowRight}');
        expect(tile(1, 2)).toHaveFocus();

        // Nothing has gone out while the pages were being moved.
        expect(sent).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: PAGES.save }));

        await waitFor(() => expect(sent).toEqual({ pageOrder: [1, 0, 2], pageRotations: null }));
        expect(await screen.findByText(PAGES.saved)).toBeInTheDocument();
      });

      it('wears a Rearranged tag while the stored order differs from the natural one', async () => {
        await openPages({
          ...detail,
          files: [fileOf(FIRST_FILE, { name: 'lease.pdf', pageCount: 3, pageOrder: [2, 0, 1] })],
        });

        expect(screen.getByText(enMessages.viewer.files.rearranged)).toBeInTheDocument();
      });

      it('wears none while the pages read as they arrived', async () => {
        // A stored order that says exactly what the file already said is not a rearrangement.
        await openPages({
          ...detail,
          files: [fileOf(FIRST_FILE, { name: 'lease.pdf', pageCount: 3, pageOrder: [0, 1, 2] })],
        });

        expect(screen.queryByText(enMessages.viewer.files.rearranged)).toBeNull();
        expect(screen.getByRole('button', { name: PAGES.arrange })).toBeInTheDocument();
      });

      it('drops the tag when the order the file arrived in is restored', async () => {
        const rearranged: DocumentDetailDto = {
          ...detail,
          files: [fileOf(FIRST_FILE, { name: 'lease.pdf', pageCount: 3, pageOrder: [2, 0, 1] })],
        };
        let restored: unknown = null;
        serve(rearranged);
        // Registered after `serve`, so these answer ahead of the handlers it put up: the document
        // reads as it arrived again once the order has been cleared.
        server.use(
          http.get(`/api/documents/${ID}`, () =>
            HttpResponse.json(envelope(restored === null ? rearranged : threePages)),
          ),
          http.patch(`/api/documents/${ID}/files/${FIRST_FILE}`, async ({ request }) => {
            restored = await request.json();
            return HttpResponse.json(envelope(threePages));
          }),
        );
        renderWithProviders(<DocumentViewerScreen id={ID} />);
        await userEvent.click(
          await screen.findByRole('tab', { name: enMessages.viewer.tabs.files }),
        );
        await screen.findByText('lease.pdf');
        await userEvent.click(screen.getByRole('button', { name: PAGES.arrange }));

        await userEvent.click(screen.getByRole('button', { name: PAGES.restore }));

        // Cleared the way Clear crop clears a crop (docs/11 §11.5c).
        await waitFor(() => expect(restored).toEqual({ pageOrder: null }));
        await waitFor(() =>
          expect(screen.queryByText(enMessages.viewer.files.rearranged)).toBeNull(),
        );
      });

      // Which way up the file lies, said on the row beside Cropped and Rearranged and on the same
      // terms (docs/11 §11.5a).
      it('wears a Turned tag for an image somebody stood upright', async () => {
        await openPages({
          ...detail,
          files: [
            fileOf(FIRST_FILE, {
              name: 'lease.pdf',
              mimeType: 'image/jpeg',
              ext: 'jpg',
              isImage: true,
              rotation: { quarterTurns: 1, mirrored: false },
            }),
          ],
        });

        expect(screen.getByText(enMessages.viewer.files.turned)).toBeInTheDocument();
      });

      it('wears one for a PDF with a page on its side', async () => {
        await openPages({
          ...detail,
          files: [
            fileOf(FIRST_FILE, { name: 'lease.pdf', pageCount: 3, pageRotations: [0, 3, 0] }),
          ],
        });

        expect(screen.getByText(enMessages.viewer.files.turned)).toBeInTheDocument();
      });

      it('wears none while every page stands the way it arrived', async () => {
        // A stored list in which nothing is turned is not a turn: the file reads as it arrived.
        await openPages({
          ...detail,
          files: [
            fileOf(FIRST_FILE, { name: 'lease.pdf', pageCount: 3, pageRotations: [0, 0, 0] }),
          ],
        });

        expect(screen.queryByText(enMessages.viewer.files.turned)).toBeNull();
      });
    });

    it('sends a chosen file in place of the row it was chosen on', async () => {
      let replaced: string | null = null;
      let sentName: string | null = null;
      server.use(
        http.post(`/api/documents/${ID}/files/:fileId/replacement`, ({ params, request }) => {
          replaced = String(params.fileId);
          sentName = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
          return HttpResponse.json(envelope(twoFiles));
        }),
      );
      await openFiles();

      await userEvent.upload(
        pickerOn('page-2.jpg'),
        new File(['x'], 'page-2-again.jpg', { type: 'image/jpeg' }),
      );

      // Neither an add nor a split: the bytes go to the file they are a better copy of, and that
      // file's position is what they take (docs/05 §5.6).
      await waitFor(() => {
        expect(replaced).toBe(SECOND_FILE);
        expect(sentName).toBe('page-2-again.jpg');
      });
      expect(await screen.findByText(enMessages.viewer.files.replaced)).toBeInTheDocument();
      // One gesture on the composition, so the reader is left looking at the composition.
      expect(screen.getByRole('tab', { name: enMessages.viewer.tabs.files })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });

    it('says nothing about earlier versions of a page nobody has replaced', async () => {
      await openFiles();

      expect(screen.queryByText(/Earlier versions/)).toBeNull();
    });

    it('lists the copies a page has had, newest first, each with a download of its own', async () => {
      const NEWER = 'ffffffff-3333-4333-8333-333333333333';
      const OLDER = 'ffffffff-4444-4444-8444-444444444444';
      await openFiles({
        ...detail,
        files: [
          fileOf(FIRST_FILE, {
            name: 'page-1.jpg',
            ext: 'jpg',
            mimeType: 'image/jpeg',
            isImage: true,
            earlierVersions: [
              versionOf(NEWER, {
                name: 'page-1-scan-2.jpg',
                trashedAt: '2026-02-02T09:00:00.000Z',
              }),
              versionOf(OLDER, { name: 'page-1-scan-1.jpg' }),
            ],
          }),
        ],
      });

      // Collapsed: what the document is made of is the row itself, and these answer a question
      // asked rarely — "what did this page look like before" (docs/11 §11.5a).
      expect(screen.queryByText('page-1-scan-2.jpg')).toBeNull();
      await userEvent.click(screen.getByText(/Earlier versions \(2\)/));

      const versions = within(versionsBlock(/Earlier versions \(2\)/));
      expect(versions.getByText('page-1-scan-2.jpg')).toBeInTheDocument();
      // Newest first, each downloading its own bytes down the same route as the row above it, by
      // its own id (docs/07 §7.3) — the old scan is still readable, which is why it was kept.
      const downloads = versions.getAllByRole('link', { name: enMessages.viewer.files.download });
      expect(downloads.map((link) => link.getAttribute('href'))).toEqual([
        `/api/documents/${ID}/files/${NEWER}/content`,
        `/api/documents/${ID}/files/${OLDER}/content`,
      ]);
    });

    it('says a library original stays on the volume rather than naming a day it will go', async () => {
      const ORIGINAL = 'ffffffff-5555-4555-8555-555555555555';
      await openFiles({
        ...detail,
        files: [
          fileOf(FIRST_FILE, {
            name: 'page-1.jpg',
            ext: 'jpg',
            mimeType: 'image/jpeg',
            isImage: true,
            earlierVersions: [
              versionOf(ORIGINAL, {
                name: 'page-1-from-the-volume.jpg',
                origin: 'LIBRARY',
                storageKey: null,
                // Nothing will ever delete it: the volume is read-only and the bytes were never
                // Legere's to remove (docs/05 §5.7a).
                purgeAfter: null,
                refs: [
                  {
                    libraryId: LIBRARY_ID,
                    libraryName: 'Invoices',
                    path: 'a/page-1.jpg',
                    status: 'EXCLUDED',
                  },
                ],
              }),
            ],
          }),
        ],
      });

      await userEvent.click(screen.getByText(/Earlier versions \(1\)/));

      const versions = within(versionsBlock(/Earlier versions \(1\)/));
      // It says so in as many words rather than showing a date that will never arrive.
      expect(versions.getByText(enMessages.viewer.files.versionOnVolume)).toBeInTheDocument();
      expect(versions.queryByText(/In the trash until/)).toBeNull();
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

  // The typed fields of the document's type (docs/03 §3.3.10a): drawn in the details pane only
  // where the type carries a schema, edited in the same form, put back by the same grey line
  // (docs/11 §11.5).
  describe('the typed fields of the document type (docs/03 §3.3.10a)', () => {
    const RECEIPT_TYPE_ID = 'bbbbbbbb-7777-4777-8777-777777777777';

    // The stored answer and the model's last reading, identical to begin with: what a document
    // looks like when the pipeline read it and nobody has corrected it yet.
    const values = {
      vendor: 'Voli',
      purchasedAt: '2026-05-12',
      total: { amount: 12.4, currency: 'EUR' },
      items: [
        { name: 'Bread', quantity: 2, amount: 1.2 },
        { name: 'Milk', quantity: 1, amount: 1.05 },
      ],
    };

    const receipt: DocumentDetailDto = {
      ...detail,
      documentType: { id: RECEIPT_TYPE_ID, slug: 'receipt', name: 'Receipt' },
      typeSource: 'MANUAL',
      extracted: {
        schema: { slug: 'receipt', version: 1 },
        values,
        sources: { vendor: 'AUTO', purchasedAt: 'AUTO', total: 'AUTO', items: 'AUTO' },
      },
      auto: { fields: values },
    };

    async function openDetails(document: DocumentDetailDto): Promise<HTMLElement> {
      serve(document);
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      return screen.getByRole('tabpanel');
    }

    it('renders the typed fields of a receipt, formatted for the reader', async () => {
      const panel = await openDetails(receipt);

      // The label comes from the message catalog — the registry carries none (docs/03 §3.3.10a) —
      // and the vendor as it was read…
      expect(within(panel).getByText(enMessages.viewer.fields.receipt.vendor)).toBeInTheDocument();
      expect(within(panel).getByText('Voli')).toBeInTheDocument();
      // …and the money formatted as currency for the reader, one fact with its ISO code.
      const total = new Intl.NumberFormat(navigator.language, {
        style: 'currency',
        currency: 'EUR',
      }).format(12.4);
      expect(within(panel).getByText(total)).toBeInTheDocument();
      // A `table` field is a small table of its rows, headers localized like the labels.
      expect(within(panel).getByText('Bread')).toBeInTheDocument();
      expect(
        within(panel).getByText(enMessages.viewer.fields.receipt.itemsColumns.name),
      ).toBeInTheDocument();
    });

    it('saves an edited typed field alone, and nothing else with it', async () => {
      let patched: unknown = null;
      server.use(
        http.patch(`/api/documents/${ID}`, async ({ request }) => {
          patched = await request.json();
          return HttpResponse.json(envelope(receipt));
        }),
      );
      const panel = await openDetails(receipt);
      const details = within(panel);
      await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.edit }));

      const vendor = details.getByRole('textbox', {
        name: enMessages.viewer.fields.receipt.vendor,
      });
      await userEvent.clear(vendor);
      await userEvent.type(vendor, 'Voli Market');
      await userEvent.click(details.getByRole('button', { name: enMessages.common.actions.save }));

      // 🔒 Only the field that changed travels (docs/11 §11.5): an untouched total sent back would
      // become MANUAL because a vendor was corrected, and no run would fill it again.
      await waitFor(() => expect(patched).toEqual({ fields: { vendor: 'Voli Market' } }));
    });

    it('puts a typed field back to what was read in one click, travelling as a reset', async () => {
      let patched: unknown = null;
      server.use(
        http.patch(`/api/documents/${ID}`, async ({ request }) => {
          patched = await request.json();
          return HttpResponse.json(envelope(receipt));
        }),
      );
      const panel = await openDetails({
        ...receipt,
        extracted: {
          schema: { slug: 'receipt', version: 1 },
          values: { ...values, vendor: 'Voli d.o.o.' },
          sources: { vendor: 'MANUAL', purchasedAt: 'AUTO', total: 'AUTO', items: 'AUTO' },
        },
      });

      // No Edit: reading "Voli d.o.o., read as Voli" and agreeing with the machine is one gesture.
      await userEvent.click(within(panel).getByRole('button', { name: 'read as Voli' }));

      // 🔒 It travels as `fields.<key>`, never as the value typed in: a value put back stops
      // claiming a person chose it (docs/03 §3.3.10a, docs/07 §7.3).
      await waitFor(() => expect(patched).toEqual({ reset: ['fields.vendor'] }));
    });

    it('draws no typed-fields group for a type that carries no schema', async () => {
      const panel = await openDetails({
        ...detail,
        documentType: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
        typeSource: 'MANUAL',
      });

      // The pane is there, the group is not: a contract states nothing typed (docs/11 §11.5).
      expect(within(panel).getByText(enMessages.viewer.details.size)).toBeInTheDocument();
      expect(within(panel).queryByText(enMessages.viewer.fields.receipt.vendor)).toBeNull();
    });
  });

  // What it says, what it is, what it cost (docs/11 §11.5): three questions about one document, and
  // only the first of them has an answer anybody may correct.
  describe('the Details pane in three sections (docs/11 §11.5)', () => {
    const RECEIPT_TYPE_ID = 'bbbbbbbb-7777-4777-8777-777777777777';

    // A typed document, so the schema's own group is on the screen to be filed with the rest.
    const receipt: DocumentDetailDto = {
      ...detail,
      documentType: { id: RECEIPT_TYPE_ID, slug: 'receipt', name: 'Receipt' },
      typeSource: 'MANUAL',
      extracted: {
        schema: { slug: 'receipt', version: 1 },
        values: { vendor: 'Voli' },
        sources: { vendor: 'AUTO' },
      },
    };

    // A step that settled and said what it spent, so the third section has a row to draw.
    function withCost(): void {
      server.use(
        http.get(`/api/documents/${ID}/events`, () =>
          HttpResponse.json(
            envelope({
              items: [
                {
                  id: 'eeeeeeee-8888-4888-8888-888888888888',
                  type: 'STEP_FINISHED',
                  at: '2026-08-12T10:00:00.000Z',
                  actor: null,
                  payload: { step: 'markdown', status: 'DONE', durationMs: 4200, chars: 1200 },
                },
              ],
              nextCursor: null,
            }),
          ),
        ),
      );
    }

    async function openDetails(document: DocumentDetailDto = receipt): Promise<HTMLElement> {
      serve(document);
      withCost();
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      return screen.getByRole('tabpanel');
    }

    // A section is addressed by its own heading: a row belongs to the section whose title stands
    // over it, which is the whole point of the split.
    function sectionOf(panel: HTMLElement, title: string): HTMLElement {
      const heading = within(panel).getByRole('heading', { name: title });
      const section = heading.closest('.ant-space-vertical');
      if (!(section instanceof HTMLElement)) throw new Error(`expected the "${title}" section`);
      return section;
    }

    it('files every row under the section that owns it', async () => {
      const panel = await openDetails();
      await within(panel).findByText(enMessages.viewer.details.cost);

      const says = within(sectionOf(panel, enMessages.viewer.details.says));
      const is = within(sectionOf(panel, enMessages.viewer.details.is));

      // What it says: everything a machine read off the page, the typed fields of its schema
      // closing the section.
      for (const label of [
        enMessages.viewer.details.documentType,
        enMessages.viewer.details.people,
        enMessages.viewer.details.subjectKinds,
        enMessages.viewer.details.subjects,
        enMessages.viewer.details.documentDate,
        enMessages.viewer.details.pageFormat,
        enMessages.viewer.details.languages,
        enMessages.viewer.details.place,
        enMessages.viewer.fields.receipt.vendor,
      ]) {
        expect(says.getByText(label)).toBeInTheDocument();
        expect(is.queryByText(label)).toBeNull();
      }

      // What it is: the artifact rather than the reading — and no longer split across the head and
      // the foot of the list with everything correctable in between (docs/11 §11.5).
      for (const label of [
        enMessages.viewer.details.size,
        enMessages.viewer.details.pages,
        enMessages.viewer.details.created,
        enMessages.viewer.details.ocr,
      ]) {
        expect(is.getByText(label)).toBeInTheDocument();
        expect(says.queryByText(label)).toBeNull();
      }

      // What it cost: one row per step that answered anything, the newest run only
      // (docs/03 §3.3.18).
      const cost = within(sectionOf(panel, enMessages.viewer.details.cost));
      expect(cost.getByText(enMessages.viewer.steps.markdown)).toBeInTheDocument();
      expect(cost.getByText(/1200/)).toBeInTheDocument();
    });

    it('hangs the Edit button in the heading of What it says and nowhere else', async () => {
      const panel = await openDetails();

      // 🔒 On the same line as the name of the section it acts on: a button over the whole pane
      // claims rows it cannot touch (docs/11 §11.5).
      const heading = within(panel).getByRole('heading', { name: enMessages.viewer.details.says });
      const head = heading.parentElement;
      if (!(head instanceof HTMLElement)) throw new Error('expected the section heading row');
      expect(
        within(head).getByRole('button', { name: enMessages.common.actions.edit }),
      ).toBeVisible();

      // And exactly one of them in the pane, so nothing above the three sections owns them all.
      expect(
        within(panel).getAllByRole('button', { name: enMessages.common.actions.edit }),
      ).toHaveLength(1);

      // Save ends what Edit started, at the other end of the same section (docs/11 §11.5).
      await userEvent.click(
        within(head).getByRole('button', { name: enMessages.common.actions.edit }),
      );
      const says = within(sectionOf(panel, enMessages.viewer.details.says));
      expect(says.getByRole('button', { name: enMessages.common.actions.save })).toBeVisible();
    });

    it('opens the form in What it says alone, leaving the two sections under it as they were', async () => {
      const panel = await openDetails();
      await within(panel).findByText(enMessages.viewer.details.cost);

      const says = sectionOf(panel, enMessages.viewer.details.says);
      const is = sectionOf(panel, enMessages.viewer.details.is);
      const cost = sectionOf(panel, enMessages.viewer.details.cost);
      const before = { is: is.innerHTML, cost: cost.innerHTML };

      await userEvent.click(
        within(says).getByRole('button', { name: enMessages.common.actions.edit }),
      );

      // The rows a person may correct became inputs…
      expect(
        within(says).getByRole('textbox', { name: enMessages.viewer.details.city }),
      ).toBeVisible();
      expect(
        within(says).getByRole('textbox', { name: enMessages.viewer.fields.receipt.vendor }),
      ).toBeVisible();

      // 🔒 …and the two sections below are untouched, to the last node of markup: the form acts on
      // the section it stands in, and there is nothing in these for it to act on (docs/11 §11.5).
      // They are held apart from it in the code as well, so a draft changing does not re-render
      // them at all.
      expect(is.innerHTML).toBe(before.is);
      expect(cost.innerHTML).toBe(before.cost);
      expect(within(is).queryAllByRole('textbox')).toHaveLength(0);
      expect(within(is).queryAllByRole('combobox')).toHaveLength(0);
      expect(within(cost).queryAllByRole('textbox')).toHaveLength(0);
    });
  });

  describe('the Related tab (docs/03 §3.3.23, docs/11 §11.5e)', () => {
    const OTHER_ID = 'bbbbbbbb-9999-4999-8999-999999999999';
    const otherDocument: DocumentListDto = {
      id: OTHER_ID,
      title: 'Act of acceptance',
      fileCount: 1,
      primaryExt: 'pdf',
      sizeBytes: '1024',
      pageCount: 1,
      documentType: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
      availability: 'AVAILABLE',
      processing: false,
      origin: 'LIBRARY',
      // It has a first page, which is what the row draws beside its title (docs/11 §11.5e).
      hasPreview: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      documentDate: null,
      people: [],
      subjects: [],
      country: null,
      city: null,
      languages: [],
      extractedSummary: null,
    };
    const linksUrl = `/api/documents/${ID}/links`;
    const suggestionsUrl = `/api/documents/${ID}/link-suggestions`;
    const edge = { document: otherDocument, linkedAt: '2026-08-15T00:00:00.000Z' };

    beforeEach(() => window.sessionStorage.clear());

    it('lists the linked documents, each a way into its own viewer', async () => {
      serve();
      server.use(http.get(linksUrl, () => HttpResponse.json(envelope({ items: [edge] }))));
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);

      expect(await screen.findByText('Act of acceptance')).toBeInTheDocument();
      expect(screen.getByText('Act of acceptance').closest('a')).toHaveAttribute(
        'href',
        `/documents/${OTHER_ID}`,
      );
      // The type it is filed under, and the first page of it — what the sidebar card never had the
      // width for, and the fastest answer to "which act was that" (docs/11 §11.5e).
      expect(screen.getByText('Contract')).toBeInTheDocument();
      expect(document.querySelector(`img[src*="/${OTHER_ID}/thumb"]`)).not.toBeNull();
    });

    // The composition of a claim about two documents has an address of its own (docs/11 §11.5e).
    it('puts the tab in the address', async () => {
      serve();
      renderWithProviders(<DocumentViewerScreen id={ID} />);

      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.related }),
      );

      expect(replace).toHaveBeenCalledWith(`/documents/${ID}/related`);
    });

    it('unlinks with one click and the row goes', async () => {
      let removed = false;
      serve();
      server.use(
        http.get(linksUrl, () => HttpResponse.json(envelope({ items: removed ? [] : [edge] }))),
        http.delete(`${linksUrl}/${OTHER_ID}`, () => {
          removed = true;
          return HttpResponse.json(envelope({ ok: true }));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      await screen.findByText('Act of acceptance');

      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.links.unlink }));

      await waitFor(() => expect(screen.queryByText('Act of acceptance')).not.toBeInTheDocument());
      expect(removed).toBe(true);
    });

    it('proposes a citing document, says which identifiers matched, and links it on accept', async () => {
      const posted: unknown[] = [];
      serve();
      server.use(
        http.get(suggestionsUrl, () =>
          HttpResponse.json(
            envelope({ items: [{ document: otherDocument, matchedTokens: ['12-2019'] }] }),
          ),
        ),
        http.post(linksUrl, async ({ request }) => {
          posted.push(await request.json());
          return HttpResponse.json(envelope(edge), { status: 201 });
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);

      // Why this is here travels with the proposal, under a heading of its own (docs/05 §5.6b).
      expect(await screen.findByText('Cites 12-2019')).toBeInTheDocument();
      expect(screen.getByText(enMessages.viewer.links.suggestions)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.links.accept }));

      await waitFor(() => expect(posted).toEqual([{ documentId: OTHER_ID }]));
    });

    it('dismisses a suggestion client-side, for the session, with no request', async () => {
      serve();
      server.use(
        http.get(suggestionsUrl, () =>
          HttpResponse.json(
            envelope({ items: [{ document: otherDocument, matchedTokens: ['12-2019'] }] }),
          ),
        ),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      await screen.findByText('Cites 12-2019');

      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.links.dismiss }));

      // The proposal goes with its heading, and the refusal is held client-side for the session —
      // the server proposes, it never remembers being refused (docs/05 §5.6b).
      await waitFor(() =>
        expect(screen.queryByText(enMessages.viewer.links.suggestions)).not.toBeInTheDocument(),
      );
      expect(
        window.sessionStorage.getItem(`legere:dismissed-link-suggestions:${ID}`) ?? '',
      ).toContain(OTHER_ID);
    });

    // 🔒 A tab that vanished with the last link would take the picker with it, and the first link
    // could then be made only on a document that already has one (docs/11 §11.5e).
    it('says there is nothing linked, and still offers the way to link something', async () => {
      serve();
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);

      expect(await screen.findByText(enMessages.viewer.links.none)).toBeInTheDocument();
      expect(
        screen.getByRole('combobox', { name: enMessages.viewer.links.link }),
      ).toBeInTheDocument();
    });

    // A row is a title, a type and a thumbnail — enough to tell two acts apart and not enough to
    // decide anything about them, so pressing one opens the document itself (docs/11 §11.5e).
    const OTHER_FILE = 'ffffffff-9999-4999-8999-999999999999';
    const otherDetail: DocumentDetailDto = {
      ...detail,
      id: OTHER_ID,
      title: 'Act of acceptance',
      documentType: { id: CATEGORY_ID, slug: 'contract', name: 'Contract' },
      files: [fileOf(OTHER_FILE, { name: 'act.pdf' })],
    };
    const proposal = { document: otherDocument, matchedTokens: ['12-2019'] };
    const peekName = enMessages.viewer.links.peek.replace('{title}', otherDocument.title);

    // The proposal, plus everything the peek of it asks for: the candidate itself and — only where
    // its own tabs are opened — its text and its journal (docs/11 §11.5e).
    function propose(): void {
      serve();
      server.use(
        http.get(suggestionsUrl, () => HttpResponse.json(envelope({ items: [proposal] }))),
        http.get(`/api/documents/${OTHER_ID}`, () => HttpResponse.json(envelope(otherDetail))),
        http.get(`/api/documents/${OTHER_ID}/markdown`, () =>
          HttpResponse.json(envelope({ markdown: '# Act' })),
        ),
        http.get(`/api/documents/${OTHER_ID}/events`, () =>
          HttpResponse.json(envelope({ items: [], nextCursor: null })),
        ),
      );
    }

    async function openPeek(): Promise<HTMLElement> {
      await userEvent.click(await screen.findByRole('button', { name: peekName }));
      return await screen.findByRole('dialog');
    }

    it('opens the proposal in place, as the viewer draws it', async () => {
      propose();
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />, { user: TEST_ADMIN });

      const peek = await openPeek();

      // The candidate, and the way to the screen where a document is worked on (docs/11 §11.5e).
      expect(within(peek).getByRole('link', { name: otherDocument.title })).toHaveAttribute(
        'href',
        `/documents/${OTHER_ID}`,
      );
      for (const tab of ['preview', 'text', 'log', 'details', 'files'] as const) {
        expect(
          within(peek).getByRole('tab', { name: enMessages.viewer.tabs[tab] }),
        ).toBeInTheDocument();
      }
      // 🔒 And not the tab that would draw another list of documents: suggestions inside a
      // suggestion are a corridor (docs/11 §11.5e).
      expect(
        within(peek).queryByRole('tab', { name: enMessages.viewer.tabs.related }),
      ).not.toBeInTheDocument();
    });

    // 🔒 A peek reads and never writes: an editor opened there is an editor nobody navigated to,
    // and the paper it would correct is not the one the question is about (docs/11 §11.5e).
    it('offers nothing that acts on the document it is showing, even to an admin', async () => {
      propose();
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />, { user: TEST_ADMIN });
      const peek = await openPeek();

      await userEvent.click(
        within(peek).getByRole('tab', { name: enMessages.viewer.tabs.details }),
      );
      expect(
        within(peek).queryByRole('button', { name: enMessages.common.actions.edit }),
      ).not.toBeInTheDocument();

      await userEvent.click(within(peek).getByRole('tab', { name: enMessages.viewer.tabs.files }));
      // The file is there to be read and downloaded; nothing replaces, splits or deletes it.
      expect(within(peek).getByText('act.pdf')).toBeInTheDocument();
      expect(
        within(peek).getByRole('link', { name: enMessages.viewer.files.download }),
      ).toBeInTheDocument();
      for (const gone of [
        enMessages.viewer.files.add,
        enMessages.viewer.files.replace,
        enMessages.viewer.files.splitOff,
        enMessages.viewer.delete.action,
      ]) {
        expect(within(peek).queryByRole('button', { name: gone })).not.toBeInTheDocument();
      }

      // And the pipeline is read, not re-run: the Log tab keeps its rows and loses its controls.
      await userEvent.click(within(peek).getByRole('tab', { name: enMessages.viewer.tabs.log }));
      expect(
        within(peek).queryByRole('button', { name: enMessages.viewer.processing.reprocessAll }),
      ).not.toBeInTheDocument();
    });

    it('links the proposal from the foot of the peek', async () => {
      const posted: unknown[] = [];
      propose();
      server.use(
        http.post(linksUrl, async ({ request }) => {
          posted.push(await request.json());
          return HttpResponse.json(envelope(edge), { status: 201 });
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      const peek = await openPeek();

      await userEvent.click(
        within(peek).getByRole('button', { name: enMessages.viewer.links.accept }),
      );

      await waitFor(() => expect(posted).toEqual([{ documentId: OTHER_ID }]));
      // The look is over: the decision was taken (docs/11 §11.5e).
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    // "These are not two papers" (docs/05 §5.6): the other's files are appended to this document,
    // and its own record goes.
    it('combines the two after the confirmation, from the row', async () => {
      const posted: unknown[] = [];
      propose();
      server.use(
        http.post(`/api/documents/${ID}/combine`, async ({ request }) => {
          posted.push(await request.json());
          return HttpResponse.json(envelope(detail));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      await screen.findByText('Cites 12-2019');

      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.links.combine }));
      // 🔒 Nothing is sent by the press itself: a press in a list of proposals is a smaller gesture
      // than what it agrees to (docs/11 §11.5e). The popconfirm's OK is the newest such button.
      expect(posted).toEqual([]);
      const confirm = screen
        .getAllByRole('button', { name: enMessages.viewer.links.combine })
        .at(-1);
      if (confirm === undefined) throw new Error('the popconfirm never opened');
      await userEvent.click(confirm);

      await waitFor(() => expect(posted).toEqual([{ documentIds: [OTHER_ID] }]));
    });

    it('combines from the peek as well, so neither place hides what the other offers', async () => {
      const posted: unknown[] = [];
      propose();
      server.use(
        http.post(`/api/documents/${ID}/combine`, async ({ request }) => {
          posted.push(await request.json());
          return HttpResponse.json(envelope(detail));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      const peek = await openPeek();

      await userEvent.click(
        within(peek).getByRole('button', { name: enMessages.viewer.links.combine }),
      );
      const confirm = screen
        .getAllByRole('button', { name: enMessages.viewer.links.combine })
        .at(-1);
      if (confirm === undefined) throw new Error('the popconfirm never opened');
      await userEvent.click(confirm);

      await waitFor(() => expect(posted).toEqual([{ documentIds: [OTHER_ID] }]));
    });

    // 🔒 The same paper scanned twice: the copy that is not being read is deleted rather than merged
    // into a document that would then hold every page twice (docs/03 §3.3.10, docs/11 §11.5e).
    it('deletes the candidate as a duplicate, for an admin, after the confirmation', async () => {
      let deleted: string | null = null;
      propose();
      server.use(
        http.delete(`/api/documents/${OTHER_ID}`, () => {
          deleted = OTHER_ID;
          return HttpResponse.json(envelope({ ok: true }));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />, { user: TEST_ADMIN });
      const peek = await openPeek();

      await userEvent.click(
        within(peek).getByRole('button', { name: enMessages.viewer.links.duplicate }),
      );
      expect(deleted).toBeNull();
      const confirm = screen
        .getAllByRole('button', { name: enMessages.viewer.links.duplicate })
        .at(-1);
      if (confirm === undefined) throw new Error('the popconfirm never opened');
      await userEvent.click(confirm);

      await waitFor(() => expect(deleted).toBe(OTHER_ID));
    });

    // 🔒 The endpoint refuses a reader (docs/07 §7.3), and a button that buys a 403 is a button that
    // lies (docs/11 §11.5e).
    it('offers the duplicate to nobody but an admin, in the row or in the peek', async () => {
      propose();
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      await screen.findByText('Cites 12-2019');

      expect(
        screen.queryByRole('button', { name: enMessages.viewer.links.duplicate }),
      ).not.toBeInTheDocument();

      const peek = await openPeek();
      expect(
        within(peek).queryByRole('button', { name: enMessages.viewer.links.duplicate }),
      ).not.toBeInTheDocument();
      // What a reader may decide is still there.
      expect(
        within(peek).getByRole('button', { name: enMessages.viewer.links.accept }),
      ).toBeInTheDocument();
    });

    // Closing a look is not refusing a suggestion: Dismiss is the row's own business
    // (docs/11 §11.5e).
    it('leaves the suggestion where it was when the peek is cancelled', async () => {
      propose();
      renderWithProviders(<DocumentViewerScreen id={ID} tab="related" />);
      const peek = await openPeek();

      await userEvent.click(
        within(peek).getByRole('button', { name: enMessages.common.actions.cancel }),
      );

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByText('Cites 12-2019')).toBeInTheDocument();
      expect(window.sessionStorage.getItem(`legere:dismissed-link-suggestions:${ID}`)).toBeNull();
    });

    // The suggestions cost the server one search per identifier the document carries (05 §5.6b),
    // and most visits never open this tab at all.
    it('asks for nothing until the tab is opened', async () => {
      let asked = 0;
      serve();
      server.use(
        http.get(suggestionsUrl, () => {
          asked += 1;
          return HttpResponse.json(envelope({ items: [] }));
        }),
      );
      renderWithProviders(<DocumentViewerScreen id={ID} />);
      await screen.findByText(detail.title);

      expect(asked).toBe(0);

      await userEvent.click(
        await screen.findByRole('tab', { name: enMessages.viewer.tabs.related }),
      );
      await waitFor(() => expect(asked).toBe(1));
    });
  });
});
