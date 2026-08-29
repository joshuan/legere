import '@testing-library/jest-dom/vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  DocumentDetailDto,
  DocumentFileDto,
  DocumentPageDto,
} from '../../../shared/contracts/documents';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { PageStrip } from './page-strip';

const DOCUMENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PDF_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const JPG_ID = 'bbbbbbbb-3333-4333-8333-333333333333';
const OTHER_DOCUMENT = 'dddddddd-4444-4444-8444-444444444444';

const PAGES_PATH = `/api/documents/${DOCUMENT_ID}/pages`;
const PDF_PATH = `/api/documents/${DOCUMENT_ID}/files/${PDF_ID}`;
const JPG_PATH = `/api/documents/${DOCUMENT_ID}/files/${JPG_ID}`;

const strings = enMessages.viewer.pages;

function pageId(index: number): string {
  return `cccccccc-5555-4555-8555-55555555555${index}`;
}

function makePage(overrides: Partial<DocumentPageDto> & { id: string }): DocumentPageDto {
  return {
    position: 0,
    fileId: PDF_ID,
    pageIndex: 0,
    turn: null,
    crop: null,
    cropSource: 'NONE',
    ...overrides,
  };
}

function makeFile(id: string, overrides: Partial<DocumentFileDto> = {}): DocumentFileDto {
  return {
    id,
    position: 0,
    name: 'lease.pdf',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: '204800',
    origin: 'MANAGED',
    available: true,
    isImage: false,
    crop: null,
    cropSource: 'NONE',
    rotation: null,
    pageOrder: null,
    pageRotations: null,
    pageCount: 2,
    refs: [],
    storageKey: `files/${id}/original.pdf`,
    earlierVersions: [],
    ...overrides,
  };
}

// A document of two files: a two-page PDF a build has counted, and a photograph after it. This is
// what the whole milestone is about — the strip reads across the boundary between them.
function makeDocument(overrides: Partial<DocumentDetailDto> = {}): DocumentDetailDto {
  return {
    id: DOCUMENT_ID,
    title: 'Lease',
    fileCount: 2,
    primaryExt: 'pdf',
    sizeBytes: '204800',
    pageCount: 3,
    documentType: null,
    availability: 'AVAILABLE',
    processing: false,
    origin: 'MANAGED',
    hasPreview: false,
    createdAt: '2026-01-02T10:00:00.000Z',
    auto: {},
    people: [],
    documentDate: null,
    subjects: [],
    ocrUsed: false,
    description: null,
    pageFormat: 'AUTO',
    titleSource: 'NONE',
    typeSource: 'NONE',
    steps: {
      canonical: 'DONE',
      preview: 'DONE',
      markdown: 'DONE',
      analysis: 'DONE',
      fields: 'DONE',
      vectorization: 'DONE',
    },
    skipReasons: {},
    languages: [],
    country: null,
    city: null,
    processingError: null,
    failedStep: null,
    pages: [
      makePage({ id: pageId(0), position: 0, fileId: PDF_ID, pageIndex: 0 }),
      makePage({ id: pageId(1), position: 1, fileId: PDF_ID, pageIndex: 1 }),
      makePage({ id: pageId(2), position: 2, fileId: JPG_ID, pageIndex: 0 }),
    ],
    files: [
      makeFile(PDF_ID),
      makeFile(JPG_ID, {
        position: 1,
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        ext: 'jpg',
        isImage: true,
        pageCount: null,
        storageKey: `files/${JPG_ID}/original.jpg`,
      }),
    ],
    createdBy: null,
    extracted: null,
    extractedSummary: null,
    ...overrides,
  };
}

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => server.close());

function say(key: keyof typeof strings, values: Record<string, string | number> = {}): string {
  let text: string = strings[key];
  for (const [name, value] of Object.entries(values)) {
    text = text.replace(`{${name}}`, String(value));
  }
  return text;
}

const source = {
  pdf: (page: number) => say('sourcePage', { file: 'lease.pdf', page }),
  jpg: () => say('sourceFile', { file: 'photo.jpg' }),
  whole: (file: string) => say('sourceWhole', { file }),
};

function tile(position: number, total: number, from: string): HTMLElement {
  return screen.getByRole('button', { name: say('tile', { position, total, source: from }) });
}

// The tiles as the strip draws them, left to right: each says where it stands and where it came
// from, which is the whole of what a person reading with the keyboard has to go on.
function stripOrder(): string[] {
  return screen
    .getAllByRole('button')
    .map((element) => element.getAttribute('aria-label') ?? '')
    .filter((label) => label.startsWith('Page '));
}

// jsdom lays nothing out, and a drag is hit-tested against the tiles themselves — so the strip is
// given a layout: 100 pixels per slot, in the order the tiles actually stand in the DOM. A tile is
// the drag button *inside* its own wrapper, which is inside the flex row's own per-page wrapper.
const SLOT_WIDTH = 100;
function layOutTiles(): void {
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLButtonElement,
  ) {
    const tileBox = this.parentElement;
    const pair = tileBox === null ? null : tileBox.parentElement;
    const row = pair === null ? null : pair.parentElement;
    const slot = row === null || pair === null ? 0 : Math.max(0, [...row.children].indexOf(pair));
    // The seam before the first tile is a child of the row too, so the pairs start at index 1.
    const left = Math.max(0, slot - 1) * SLOT_WIDTH;
    return {
      x: left,
      y: 0,
      left,
      right: left + SLOT_WIDTH - 10,
      top: 0,
      bottom: 100,
      width: SLOT_WIDTH - 10,
      height: 100,
      toJSON: () => ({}),
    };
  });
}

// jsdom has no `PointerEvent` and no pointer capture at all, and its `fireEvent.pointerMove` drops
// the coordinates on the way — so a drag is dispatched as a mouse event carrying the pointer's own
// name, which is exactly what the strip listens for and what a finger sends on a real screen.
function pointer(type: string, x: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, clientX: x, clientY: 50 });
}

// Counts what actually left the browser, so "sends nothing" is a fact rather than an absence of
// assertions.
function captureWrites(): {
  order: () => unknown;
  turns: () => Array<{ pageId: string; body: unknown }>;
  count: () => number;
} {
  let sentOrder: unknown = null;
  const turns: Array<{ pageId: string; body: unknown }> = [];
  let calls = 0;
  server.use(
    http.patch(PAGES_PATH, async ({ request }) => {
      calls += 1;
      sentOrder = await request.json();
      return HttpResponse.json(envelope(makeDocument()));
    }),
    http.patch(`${PAGES_PATH}/:pageId`, async ({ params, request }) => {
      calls += 1;
      turns.push({ pageId: String(params.pageId), body: await request.json() });
      return HttpResponse.json(envelope(makeDocument()));
    }),
  );
  return { order: () => sentOrder, turns: () => turns, count: () => calls };
}

function open(document: DocumentDetailDto = makeDocument(), onInsertFiles = vi.fn()) {
  const result = renderWithProviders(
    <PageStrip document={document} onInsertFiles={onInsertFiles} />,
  );
  return { ...result, onInsertFiles };
}

describe('PageStrip', () => {
  it('draws every page of both files in document order, each saying where it came from', () => {
    const { container } = open();

    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.pdf(1) }),
      say('tile', { position: 2, total: 3, source: source.pdf(2) }),
      say('tile', { position: 3, total: 3, source: source.jpg() }),
    ]);
    // A page of a PDF is drawn from the page-thumb route by its own 0-based index; a photograph is
    // its own bytes (docs/07 §7.3).
    const pictures = [...container.querySelectorAll('img')].map((image) =>
      image.getAttribute('src'),
    );
    expect(pictures).toEqual([
      `${PDF_PATH}/pages/0/thumb`,
      `${PDF_PATH}/pages/1/thumb`,
      `${JPG_PATH}/content`,
    ]);
  });

  // 🔒 A file nobody has counted the pages of is one entry standing for the whole of it, and the
  // strip says so rather than drawing a page it cannot name (docs/03 §3.3.17, ADR-025).
  it('draws a file held whole as one tile that says so, with no picture and no turn', () => {
    const held = makeDocument({
      pages: [
        makePage({ id: pageId(0), position: 0, fileId: PDF_ID, pageIndex: null }),
        makePage({ id: pageId(1), position: 1, fileId: JPG_ID, pageIndex: 0 }),
      ],
      files: [
        makeFile(PDF_ID, { name: 'unread.pdf', pageCount: null }),
        makeFile(JPG_ID, {
          position: 1,
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          ext: 'jpg',
          isImage: true,
          pageCount: null,
        }),
      ],
    });
    const { container } = open(held);

    // It occupies exactly one position, and it is honest about what it is.
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 2, source: source.whole('unread.pdf') }),
      say('tile', { position: 2, total: 2, source: source.jpg() }),
    ]);
    expect(screen.getByText(strings.whole)).toBeInTheDocument();
    // One picture, and it belongs to the photograph: there is no page of the PDF to render.
    expect([...container.querySelectorAll('img')]).toHaveLength(1);
    // Nor anything to turn or crop on an entry that is not a page yet.
    expect(screen.getByRole('button', { name: say('turnLeft', { position: 1 }) })).toBeDisabled();
    expect(screen.getByRole('button', { name: say('crop', { position: 1 }) })).toBeDisabled();
    // The photograph beside it is a page like any other.
    expect(screen.getByRole('button', { name: say('turnLeft', { position: 2 }) })).toBeEnabled();
  });

  // 🔒 The keyboard path, end to end: focus a page, move it with the arrows, save what came out. A
  // hit area only a mouse can use is half a fix (docs/11 §11.3, §11.5a).
  it('moves a focused page one position per arrow key and keeps the focus on it', async () => {
    open();

    await userEvent.click(tile(1, 3, source.pdf(1)));
    expect(tile(1, 3, source.pdf(1))).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.pdf(2) }),
      say('tile', { position: 2, total: 3, source: source.pdf(1) }),
      say('tile', { position: 3, total: 3, source: source.jpg() }),
    ]);
    // The page that moved still has the focus, or the second arrow key would land on nothing.
    expect(tile(2, 3, source.pdf(1))).toHaveFocus();

    // And across the boundary between the two files, which is the whole point of one strip.
    await userEvent.keyboard('{ArrowRight}');
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.pdf(2) }),
      say('tile', { position: 2, total: 3, source: source.jpg() }),
      say('tile', { position: 3, total: 3, source: source.pdf(1) }),
    ]);

    // The last position is the last position: an arrow past the end moves nothing.
    await userEvent.keyboard('{ArrowRight}');
    expect(tile(3, 3, source.pdf(1))).toBeInTheDocument();
  });

  // A pointer, and a finger is one: the page follows it and the strip closes around where it lands.
  it('drags a page across the boundary between two files', async () => {
    const writes = captureWrites();
    layOutTiles();
    open();

    const dragged = tile(3, 3, source.jpg());
    fireEvent(dragged, pointer('pointerdown', 245));
    // Over the first slot, two pages back.
    fireEvent(dragged, pointer('pointermove', 45));

    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.jpg() }),
      say('tile', { position: 2, total: 3, source: source.pdf(1) }),
      say('tile', { position: 3, total: 3, source: source.pdf(2) }),
    ]);

    fireEvent(dragged, pointer('pointerup', 45));
    // A page let go moves nothing further, and the drag itself sent nothing.
    fireEvent(dragged, pointer('pointermove', 245));
    expect(writes.count()).toBe(0);

    // And what it arranged is what Save sends: the whole order, every page exactly once.
    await userEvent.click(screen.getByRole('button', { name: strings.save }));
    await waitFor(() =>
      expect(writes.order()).toEqual({ order: [pageId(2), pageId(0), pageId(1)] }),
    );
  });

  it('sends the whole order on Save, and nothing until then', async () => {
    const writes = captureWrites();
    open();

    await userEvent.click(tile(1, 3, source.pdf(1)));
    await userEvent.keyboard('{ArrowRight}');
    expect(writes.count()).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: strings.save }));

    await waitFor(() =>
      expect(writes.order()).toEqual({ order: [pageId(1), pageId(0), pageId(2)] }),
    );
    expect(await screen.findByText(strings.saved)).toBeInTheDocument();
  });

  it('discards the pending order on Cancel and sends nothing at all', async () => {
    const writes = captureWrites();
    open();

    await userEvent.click(tile(1, 3, source.pdf(1)));
    await userEvent.keyboard('{ArrowRight}');
    expect(tile(2, 3, source.pdf(1))).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: strings.cancel }));

    // Back to what the document says, with nothing having gone out.
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.pdf(1) }),
      say('tile', { position: 2, total: 3, source: source.pdf(2) }),
      say('tile', { position: 3, total: 3, source: source.jpg() }),
    ]);
    expect(writes.count()).toBe(0);
    // And neither button asks to be pressed while the strip and the document agree.
    expect(screen.getByRole('button', { name: strings.save })).toBeDisabled();
    expect(screen.getByRole('button', { name: strings.cancel })).toBeDisabled();
  });

  it('turns one page at a time and draws the thumbnail turned with it', async () => {
    const writes = captureWrites();
    open();

    await userEvent.click(screen.getByRole('button', { name: say('turnRight', { position: 2 }) }));

    // 🔒 The picture is still the page as it arrived — the same request, the same cache key — and
    // the strip turns what it draws (docs/07 §7.3).
    const thumb = screen.getByTestId(`page-thumb-${pageId(1)}`);
    expect(thumb).toHaveAttribute('src', `${PDF_PATH}/pages/1/thumb`);
    expect(thumb.style.transform).toBe('rotate(90deg)');
    // Its neighbours did not move, and nothing has gone out.
    expect(screen.getByTestId(`page-thumb-${pageId(0)}`).style.transform).toBe('');
    expect(writes.count()).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: strings.save }));

    // One request per page whose turn changed, and no order request: nothing moved.
    await waitFor(() =>
      expect(writes.turns()).toEqual([
        { pageId: pageId(1), body: { turn: { quarterTurns: 1, mirrored: false } } },
      ]),
    );
    expect(writes.order()).toBeNull();
  });

  it('comes back to where it started after four presses, with nothing to save', async () => {
    const writes = captureWrites();
    open();

    for (const press of [0, 1, 2, 3]) {
      void press;
      await userEvent.click(screen.getByRole('button', { name: say('turnLeft', { position: 1 }) }));
    }

    expect(screen.getByTestId(`page-thumb-${pageId(0)}`).style.transform).toBe('');
    // A turn of nothing at all is not a turn: the page reads as it arrived (docs/03 §3.3.17).
    expect(screen.getByRole('button', { name: strings.save })).toBeDisabled();
    expect(writes.count()).toBe(0);
  });

  it('removes a page, having asked first', async () => {
    let removed: string | null = null;
    server.use(
      http.delete(`${PAGES_PATH}/:pageId`, ({ params }) => {
        removed = String(params.pageId);
        return HttpResponse.json(envelope(makeDocument()));
      }),
    );
    open();

    await userEvent.click(screen.getByRole('button', { name: say('remove', { position: 2 }) }));
    // Destructive, so it names what it is about before it does anything (docs/11 §11.14).
    expect(await screen.findByText(say('removeConfirm', { position: 2 }))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: strings.removeOk }));

    await waitFor(() => expect(removed).toBe(pageId(1)));
    expect(await screen.findByText(strings.removeDone)).toBeInTheDocument();
  });

  // 🔒 A document is emptied by deleting it, not by taking its pages away one at a time.
  it('does not offer to remove the only page there is', () => {
    open(
      makeDocument({
        pages: [makePage({ id: pageId(0), position: 0, fileId: PDF_ID, pageIndex: 0 })],
        files: [makeFile(PDF_ID)],
      }),
    );

    expect(screen.getByRole('button', { name: say('remove', { position: 1 }) })).toBeDisabled();
  });

  it('cuts the document before a page, and never before the first', async () => {
    let cut: unknown = null;
    server.use(
      http.post(`/api/documents/${DOCUMENT_ID}/split`, async ({ request }) => {
        cut = await request.json();
        return HttpResponse.json(
          envelope({ document: makeDocument(), splitDocumentIds: [OTHER_DOCUMENT] }),
        );
      }),
    );
    open();

    // A cut before the first page is a cut with nothing on one side of it.
    expect(screen.getByRole('button', { name: say('splitHere', { position: 1 }) })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: say('splitHere', { position: 3 }) }));

    // The boundary is the page's own position in the list the server last answered with.
    await waitFor(() => expect(cut).toEqual({ at: [2] }));
    expect(await screen.findByText(strings.splitDone)).toBeInTheDocument();
  });

  it('moves a selection into a new document', async () => {
    let moved: unknown = null;
    server.use(
      http.post(`${PAGES_PATH}/move`, async ({ request }) => {
        moved = await request.json();
        return HttpResponse.json(
          envelope({ document: makeDocument(), movedToDocumentId: OTHER_DOCUMENT }),
        );
      }),
    );
    open();

    await userEvent.click(screen.getByRole('checkbox', { name: say('select', { position: 1 }) }));
    await userEvent.click(screen.getByRole('checkbox', { name: say('select', { position: 2 }) }));
    expect(screen.getByText(say('selected', { count: 2 }))).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: strings.moveSelection }));
    expect(await screen.findByText(strings.moveTitle)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: strings.moveConfirm }));

    // `documentId: null` is "a new document made to hold them", which takes no position at all.
    await waitFor(() =>
      expect(moved).toEqual({ pageIds: [pageId(0), pageId(1)], documentId: null }),
    );
    expect(await screen.findByText(strings.movedDone)).toBeInTheDocument();
  });

  // 🔒 docs/11 §11.5a says the dialog "says which it will move", and it did not: a tile's own Move
  // and a Move of twelve ticked pages opened the same generic modal, so there was nothing to check
  // before pressing the button.
  it('names the pages it will move, in document order', async () => {
    open();

    // Ticked back to front, on purpose: the strip reads left to right and so must the sentence.
    await userEvent.click(screen.getByRole('checkbox', { name: say('select', { position: 3 }) }));
    await userEvent.click(screen.getByRole('checkbox', { name: say('select', { position: 1 }) }));
    await userEvent.click(screen.getByRole('button', { name: strings.moveSelection }));

    expect(await screen.findByText('2 pages leave this document: 1, 3.')).toBeInTheDocument();
  });

  // And a tile's own Move is the same request with one id in it, so it is the same sentence with
  // one number in it.
  it('names the single page a tile’s own Move will take', async () => {
    open();

    await userEvent.click(screen.getByRole('button', { name: say('move', { position: 2 }) }));

    expect(await screen.findByText('Page 2 leaves this document.')).toBeInTheDocument();
  });

  // 🔒 Every non-text search spends an outbound embeddings call and is metered at 30 per 60 s per
  // caller (docs/08 §8.4), so a title typed a character at a time used to end in `RATE_LIMITED` and
  // an empty list. One word, one search — the same debounce the overlay uses (docs/11 §11.1a).
  it('searches once for a title typed at speed, not once per character', async () => {
    const asked: string[] = [];
    server.use(
      http.get('/api/search', ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('q') ?? '');
        return HttpResponse.json(envelope({ items: [], semanticAvailable: true }));
      }),
    );
    open();

    await userEvent.click(screen.getByRole('button', { name: say('move', { position: 1 }) }));
    await userEvent.click(await screen.findByRole('radio', { name: strings.moveToExisting }));
    await userEvent.type(screen.getByRole('combobox', { name: strings.moveSearch }), 'lease');

    await waitFor(() => expect(asked).toEqual(['lease']));
    // And it stays one: nothing lands late for the five keystrokes that were passed over.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(asked).toEqual(['lease']);
  });

  // 🔒 A position is a place in the list the server was last shown, so everything that names one
  // goes quiet while the strip holds an order nobody has sent (docs/11 §11.5a).
  it('takes the controls that name a position away while an order is unsaved', async () => {
    open();

    await userEvent.click(tile(1, 3, source.pdf(1)));
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByText(strings.pendingNote)).toBeInTheDocument();
    for (const name of [
      say('remove', { position: 2 }),
      say('splitHere', { position: 3 }),
      say('move', { position: 2 }),
      say('crop', { position: 3 }),
      say('insert', { position: 1 }),
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    // The turn is not a sender: it rides with the order and goes out with it.
    expect(screen.getByRole('button', { name: say('turnLeft', { position: 1 }) })).toBeEnabled();
  });

  it('hands a file dropped at a seam to the position it was dropped at', () => {
    const { onInsertFiles } = open();

    const dropped = new File(['x'], 'between.jpg', { type: 'image/jpeg' });
    fireEvent.drop(screen.getByTestId('page-seam-2'), {
      dataTransfer: { files: [dropped], types: ['Files'] },
    });

    expect(onInsertFiles).toHaveBeenCalledWith([dropped], 2);
  });

  // Enters and leaves are counted in pairs, the way the page-wide zone counts them (docs/11 §11.3).
  // The seam has a child — the picker's own button sits in the middle of it — and `dragleave` fires
  // the moment a pointer crosses into one, so a highlight that believed the first leave went out
  // and came back in the next frame, under a pointer that never left the seam.
  it('keeps a seam lit while the pointer crosses into the control inside it', () => {
    open();

    const seam = screen.getByTestId('page-seam-1');
    const files = { dataTransfer: { files: [], types: ['Files'] } };
    fireEvent.dragEnter(seam, files);
    const lit = seam.style.outline;
    expect(lit).not.toBe('none');

    // Into the button: the browser fires an enter for the child and a leave for the seam, in that
    // order, and the seam is still under the pointer throughout.
    const inner = within(seam).getByRole('button', { name: say('insert', { position: 2 }) });
    fireEvent.dragEnter(inner, files);
    fireEvent.dragLeave(seam, files);
    expect(seam.style.outline).toBe(lit);

    // And it does go out when the drag really leaves: one leave for each of the two enters.
    fireEvent.dragLeave(seam, files);
    expect(seam.style.outline).toBe('none');
  });

  // 🔒 The browser accepts a drop the strip will refuse — a position is a place in the list the
  // server was last shown — and it used to be dropped in silence, the file simply gone.
  it('says why a file dropped at a seam is refused while an order is unsaved', async () => {
    const { onInsertFiles } = open();

    await userEvent.click(tile(1, 3, source.pdf(1)));
    await userEvent.keyboard('{ArrowRight}');

    fireEvent.drop(screen.getByTestId('page-seam-1'), {
      dataTransfer: {
        files: [new File(['x'], 'between.jpg', { type: 'image/jpeg' })],
        types: ['Files'],
      },
    });

    expect(
      await screen.findByText(strings.pendingNote, { selector: '.ant-message *' }),
    ).toBeInTheDocument();
    expect(onInsertFiles).not.toHaveBeenCalled();
  });

  // 🔒 The document polls every five seconds while it is processing — which it is after every
  // composition edit — so the reset key decides whether somebody else's reorder wipes an
  // arrangement nobody has saved. It is keyed on the **set** of pages: the ids in position order
  // changed under every reorder too (docs/11 §11.5a).
  it('keeps an unsaved arrangement when the same pages are reordered underneath it', () => {
    const { rerender } = open();

    fireEvent.click(tile(1, 3, source.pdf(1)));
    fireEvent.keyDown(tile(1, 3, source.pdf(1)), { key: 'ArrowRight' });
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.pdf(2) }),
      say('tile', { position: 2, total: 3, source: source.pdf(1) }),
      say('tile', { position: 3, total: 3, source: source.jpg() }),
    ]);

    // Somebody else moves the photograph to the front; the poll answers with the same three pages
    // in a different order.
    const elsewhere = makeDocument();
    rerender(
      <PageStrip
        document={{
          ...elsewhere,
          pages: [
            makePage({ id: pageId(2), position: 0, fileId: JPG_ID, pageIndex: 0 }),
            makePage({ id: pageId(0), position: 1, fileId: PDF_ID, pageIndex: 0 }),
            makePage({ id: pageId(1), position: 2, fileId: PDF_ID, pageIndex: 1 }),
          ],
        }}
        onInsertFiles={vi.fn()}
      />,
    );

    // The arrangement is still on the screen, and still the thing Save would send.
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 3, source: source.pdf(2) }),
      say('tile', { position: 2, total: 3, source: source.pdf(1) }),
      say('tile', { position: 3, total: 3, source: source.jpg() }),
    ]);
    expect(screen.getByRole('button', { name: strings.save })).toBeEnabled();
  });

  // 🔒 And where it genuinely cannot be kept — the set of pages is not the set it was arranged
  // against — the strip says so instead of dropping the work behind an error toast.
  it('says so when a page comes or goes under an arrangement nobody had saved', async () => {
    const { rerender } = open();

    fireEvent.click(tile(1, 3, source.pdf(1)));
    fireEvent.keyDown(tile(1, 3, source.pdf(1)), { key: 'ArrowRight' });

    const shorter = makeDocument();
    rerender(
      <PageStrip
        document={{
          ...shorter,
          pageCount: 2,
          pages: [
            makePage({ id: pageId(0), position: 0, fileId: PDF_ID, pageIndex: 0 }),
            makePage({ id: pageId(1), position: 1, fileId: PDF_ID, pageIndex: 1 }),
          ],
        }}
        onInsertFiles={vi.fn()}
      />,
    );

    expect(await screen.findByText(strings.discarded)).toBeInTheDocument();
    // Back to what the document says, rather than half of an order about a document that is gone.
    expect(stripOrder()).toEqual([
      say('tile', { position: 1, total: 2, source: source.pdf(1) }),
      say('tile', { position: 2, total: 2, source: source.pdf(2) }),
    ]);
  });

  it('says nothing when the pages change and there was nothing to lose', async () => {
    const { rerender } = open();

    const grown = makeDocument();
    rerender(
      <PageStrip
        document={{
          ...grown,
          pages: [
            ...grown.pages,
            makePage({ id: pageId(3), position: 3, fileId: JPG_ID, pageIndex: 0 }),
          ],
        }}
        onInsertFiles={vi.fn()}
      />,
    );

    expect(stripOrder()).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(strings.discarded)).not.toBeInTheDocument();
  });

  it('keeps the pending order and localizes the failure when the save is refused', async () => {
    server.use(
      http.patch(PAGES_PATH, () =>
        HttpResponse.json(errorEnvelope('VALIDATION_FAILED', 'the pages do not add up'), {
          status: 422,
        }),
      ),
    );
    open();

    await userEvent.click(tile(1, 3, source.pdf(1)));
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.click(screen.getByRole('button', { name: strings.save }));

    expect(await screen.findByText(enMessages.errors.codes.VALIDATION_FAILED)).toBeInTheDocument();
    // The work is not thrown away by a request that failed.
    expect(tile(2, 3, source.pdf(1))).toBeInTheDocument();
  });

  // 🔒 A peek is a look at somebody else's document: the pages stay and the work goes
  // (docs/11 §11.5e).
  it('shows the pages and takes every control away when it is read-only', () => {
    renderWithProviders(<PageStrip document={makeDocument()} onInsertFiles={vi.fn()} readOnly />);

    expect(stripOrder()).toHaveLength(3);
    for (const name of [
      strings.save,
      say('turnLeft', { position: 1 }),
      say('remove', { position: 2 }),
      say('insert', { position: 1 }),
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
