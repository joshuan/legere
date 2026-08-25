import '@testing-library/jest-dom/vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocumentDetailDto, DocumentFileDto } from '../../../shared/contracts/documents';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { PageArranger } from './page-arranger';

const DOCUMENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const FILE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const SAVE_PATH = `/api/documents/${DOCUMENT_ID}/files/${FILE_ID}`;

function makeFile(overrides: Partial<DocumentFileDto> = {}): DocumentFileDto {
  return {
    id: FILE_ID,
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
    // Three pages, standing in the order and the way up they arrived — which is what a strip
    // opens on (docs/03 §3.3.16).
    pageOrder: null,
    pageRotations: null,
    pageCount: 3,
    refs: [],
    storageKey: `files/${FILE_ID}/original.pdf`,
    earlierVersions: [],
    ...overrides,
  };
}

// What `PATCH …/files/:fileId` answers with: the whole document (docs/07 §7.3). The client validates
// it against the contract, so it has to be a real one.
const rebuilt: DocumentDetailDto = {
  id: DOCUMENT_ID,
  title: 'Lease',
  fileCount: 1,
  primaryExt: 'pdf',
  sizeBytes: '204800',
  pageCount: 3,
  documentType: null,
  availability: 'AVAILABLE',
  processing: true,
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
    canonical: 'PENDING',
    preview: 'PENDING',
    markdown: 'PENDING',
    analysis: 'PENDING',
    fields: 'PENDING',
    vectorization: 'PENDING',
  },
  skipReasons: {},
  languages: [],
  country: null,
  city: null,
  processingError: null,
  failedStep: null,
  files: [makeFile()],
  createdBy: null,
  extracted: null,
  extractedSummary: null,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(() => server.close());

// jsdom lays nothing out, and a drag is hit-tested against the tiles themselves — so the strip is
// given a layout: 100 pixels per slot, in the order the tiles actually stand in the DOM, which is
// what makes a pointer at x=245 a pointer over the third page. A tile is the drag button *inside*
// its own wrapper — the two turns are its siblings, and a button inside a button is not a thing a
// browser hit-tests the way anybody means it.
const SLOT_WIDTH = 100;
function layOutTiles(): void {
  vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLButtonElement,
  ) {
    const wrapper = this.parentElement;
    const row = wrapper === null ? null : wrapper.parentElement;
    const slot =
      row === null || wrapper === null ? 0 : Math.max(0, [...row.children].indexOf(wrapper));
    const left = slot * SLOT_WIDTH;
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

// Captures the body of the save so a test can read the permutation it was actually sent, and counts
// the requests so "sends nothing" is a fact rather than an absence of assertions.
function captureSave(): { body: () => unknown; count: () => number } {
  let received: unknown = null;
  let calls = 0;
  server.use(
    http.patch(SAVE_PATH, async ({ request }) => {
      calls += 1;
      received = await request.json();
      return HttpResponse.json(envelope(rebuilt));
    }),
  );
  return { body: () => received, count: () => calls };
}

const pages = { ...enMessages.viewer.files.pages };

// The tiles as the strip draws them, left to right: each says its own page number and where it
// stands, which is the whole of what a person reading with the keyboard has to go on.
function strip(): string[] {
  return screen
    .getAllByRole('button')
    .map((tile) => tile.getAttribute('aria-label') ?? '')
    .filter((label) => label.startsWith('Page '));
}

function tile(page: number, position: number, total = 3): HTMLElement {
  return screen.getByRole('button', {
    name: pages.page
      .replace('{page}', String(page))
      .replace('{position}', String(position))
      .replace('{total}', String(total)),
  });
}

function open(file: DocumentFileDto = makeFile()): HTMLElement {
  const { container } = renderWithProviders(<PageArranger documentId={DOCUMENT_ID} file={file} />);
  return container;
}

describe('PageArranger', () => {
  it('opens on the stored order, one numbered thumbnail per page', () => {
    const container = open(makeFile({ pageOrder: [2, 0, 1] }));

    expect(strip()).toEqual(['Page 3, now 1 of 3', 'Page 1, now 2 of 3', 'Page 2, now 3 of 3']);
    // Each thumbnail is one page of the original, by its 0-based index (docs/07 §7.3).
    const thumbs = [...container.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(thumbs).toEqual([
      `${SAVE_PATH}/pages/2/thumb`,
      `${SAVE_PATH}/pages/0/thumb`,
      `${SAVE_PATH}/pages/1/thumb`,
    ]);
  });

  it('opens on the order the pages arrived in when none is stored', () => {
    open();

    expect(strip()).toEqual(['Page 1, now 1 of 3', 'Page 2, now 2 of 3', 'Page 3, now 3 of 3']);
  });

  // 🔒 The keyboard path, end to end: focus a page, move it with the arrows, save what came out.
  // A hit area only a mouse can use is half a fix (docs/11 §11.5a).
  it('moves a focused page one position per arrow key and keeps the focus on it', async () => {
    open();

    await userEvent.click(tile(1, 1));
    expect(tile(1, 1)).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 1, now 2 of 3', 'Page 3, now 3 of 3']);
    // The page that moved still has the focus, or the second arrow key would land on nothing.
    expect(tile(1, 2)).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 3, now 2 of 3', 'Page 1, now 3 of 3']);
    expect(tile(1, 3)).toHaveFocus();

    // The last position is the last position: an arrow past the end moves nothing.
    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 3, now 2 of 3', 'Page 1, now 3 of 3']);

    // And back the other way, one position at a time.
    await userEvent.keyboard('{ArrowLeft}');
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 1, now 2 of 3', 'Page 3, now 3 of 3']);
    expect(tile(1, 2)).toHaveFocus();
  });

  // A pointer, and a finger is one: the page follows it and the strip closes around where it lands
  // (docs/11 §11.5a).
  it('drags a page into place with a pointer, whatever is holding it', async () => {
    const save = captureSave();
    layOutTiles();
    open();

    const dragged = tile(1, 1);
    fireEvent(dragged, pointer('pointerdown', 45));
    // Over the third slot, two pages along.
    fireEvent(dragged, pointer('pointermove', 245));

    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 3, now 2 of 3', 'Page 1, now 3 of 3']);

    fireEvent(dragged, pointer('pointerup', 245));
    // A page let go moves nothing further, and the drag itself sent nothing.
    fireEvent(dragged, pointer('pointermove', 45));
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 3, now 2 of 3', 'Page 1, now 3 of 3']);
    expect(save.count()).toBe(0);

    // And what it arranged is what Save sends.
    await userEvent.click(screen.getByRole('button', { name: pages.save }));
    await waitFor(() => expect(save.body()).toEqual({ pageOrder: [1, 2, 0], pageRotations: null }));
  });

  it('sends the whole permutation on Save, and nothing until then', async () => {
    const save = captureSave();
    open();

    await userEvent.click(tile(1, 1));
    await userEvent.keyboard('{ArrowRight}');

    // Nothing is sent while a page is being moved (docs/11 §11.5a).
    expect(save.count()).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: pages.save }));

    // The complete order, every page of the file exactly once — not "this one moved" (docs/07 §7.3).
    await waitFor(() => expect(save.body()).toEqual({ pageOrder: [1, 0, 2], pageRotations: null }));
    expect(await screen.findByText(pages.saved)).toBeInTheDocument();
  });

  it('discards the pending order on Cancel and sends nothing at all', async () => {
    const save = captureSave();
    open();

    await userEvent.click(tile(1, 1));
    await userEvent.keyboard('{ArrowRight}');
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 1, now 2 of 3', 'Page 3, now 3 of 3']);

    await userEvent.click(screen.getByRole('button', { name: pages.cancel }));

    // Back to what the file says, with nothing having gone out.
    expect(strip()).toEqual(['Page 1, now 1 of 3', 'Page 2, now 2 of 3', 'Page 3, now 3 of 3']);
    expect(save.count()).toBe(0);
    // And neither button asks to be pressed when the strip and the file agree.
    expect(screen.getByRole('button', { name: pages.save })).toBeDisabled();
    expect(screen.getByRole('button', { name: pages.cancel })).toBeDisabled();
  });

  it('sends null for Restore original order, the way Clear crop clears a crop', async () => {
    const save = captureSave();
    open(makeFile({ pageOrder: [2, 0, 1] }));

    await userEvent.click(screen.getByRole('button', { name: pages.restore }));

    await waitFor(() => expect(save.body()).toEqual({ pageOrder: null }));
    expect(await screen.findByText(pages.restored)).toBeInTheDocument();
    // The pages read as they arrived again.
    expect(strip()).toEqual(['Page 1, now 1 of 3', 'Page 2, now 2 of 3', 'Page 3, now 3 of 3']);
  });

  it('offers nothing to restore on a file that stands as it arrived', () => {
    open();

    expect(screen.getByRole('button', { name: pages.restore })).toBeDisabled();
  });

  // 🔒 Nothing to arrange, nothing drawn (docs/11 §11.5a).
  it('draws no strip for a single-page file', () => {
    const container = open(makeFile({ pageCount: 1 }));

    expect(screen.queryByTestId('page-strip')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws no strip for a file no build has counted the pages of', () => {
    open(makeFile({ pageCount: null }));

    expect(screen.queryByTestId('page-strip')).toBeNull();
  });

  it('draws no strip for an image', () => {
    const container = open(
      makeFile({ mimeType: 'image/jpeg', ext: 'jpg', isImage: true, pageCount: 4 }),
    );

    expect(screen.queryByTestId('page-strip')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  // Which way up each page lies, one page at a time (docs/11 §11.5a).
  const turnButton = (page: number, direction: 'rotateLeft' | 'rotateRight'): HTMLElement =>
    screen.getByRole('button', { name: pages[direction].replace('{page}', String(page)) });

  it('turns one page at a time and draws the thumbnail turned with it', async () => {
    open();

    await userEvent.click(turnButton(2, 'rotateRight'));

    // 🔒 The picture is still the page as it arrived — the same request, the same cache key — and
    // the strip turns what it draws (docs/07 §7.3).
    const thumb = screen.getByTestId('page-thumb-1');
    expect(thumb).toHaveAttribute('src', `${SAVE_PATH}/pages/1/thumb`);
    expect(thumb.style.transform).toBe('rotate(90deg)');
    // Its neighbours did not move.
    expect(screen.getByTestId('page-thumb-0').style.transform).toBe('');
  });

  it('comes back to where it started after four presses', async () => {
    const save = captureSave();
    open();

    for (let press = 0; press < 4; press += 1) {
      await userEvent.click(turnButton(1, 'rotateLeft'));
    }

    expect(screen.getByTestId('page-thumb-0').style.transform).toBe('');
    // And there is nothing to save, because nothing differs from what the file says.
    expect(screen.getByRole('button', { name: pages.save })).toBeDisabled();
    expect(save.count()).toBe(0);
  });

  it('sends one turn per page beside the whole order on Save', async () => {
    const save = captureSave();
    open();

    await userEvent.click(turnButton(2, 'rotateRight'));
    await userEvent.click(turnButton(3, 'rotateLeft'));
    expect(save.count()).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: pages.save }));

    // Indexed by the page's own number, the way the order names its pages (docs/03 §3.3.16).
    await waitFor(() =>
      expect(save.body()).toEqual({ pageOrder: [0, 1, 2], pageRotations: [0, 1, 3] }),
    );
    expect(await screen.findByText(pages.saved)).toBeInTheDocument();
  });

  it('opens on the turns the file already carries and discards pending ones on Cancel', async () => {
    const save = captureSave();
    open(makeFile({ pageRotations: [0, 2, 0] }));

    expect(screen.getByTestId('page-thumb-1').style.transform).toBe('rotate(180deg)');

    await userEvent.click(turnButton(1, 'rotateRight'));
    expect(screen.getByTestId('page-thumb-0').style.transform).toBe('rotate(90deg)');

    await userEvent.click(screen.getByRole('button', { name: pages.cancel }));

    // Back to what the file says, with nothing having gone out.
    expect(screen.getByTestId('page-thumb-0').style.transform).toBe('');
    expect(screen.getByTestId('page-thumb-1').style.transform).toBe('rotate(180deg)');
    expect(save.count()).toBe(0);
  });

  it('sends null for Reset turns, the way Restore original order sends null for the order', async () => {
    const save = captureSave();
    open(makeFile({ pageRotations: [0, 1, 0] }));

    await userEvent.click(screen.getByRole('button', { name: pages.resetTurns }));

    await waitFor(() => expect(save.body()).toEqual({ pageRotations: null }));
    expect(await screen.findByText(pages.turnsRestored)).toBeInTheDocument();
    // The pages read the way up they arrived again.
    expect(screen.getByTestId('page-thumb-1').style.transform).toBe('');
  });

  it('offers nothing to reset on a file whose pages stand the way they arrived', () => {
    open();

    expect(screen.getByRole('button', { name: pages.resetTurns })).toBeDisabled();
  });

  it('keeps the pending order and localizes the failure when the save is refused', async () => {
    server.use(
      http.patch(SAVE_PATH, () =>
        HttpResponse.json(errorEnvelope('VALIDATION_FAILED', 'the pages do not add up'), {
          status: 422,
        }),
      ),
    );
    open();

    await userEvent.click(tile(1, 1));
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.click(screen.getByRole('button', { name: pages.save }));

    expect(await screen.findByText(enMessages.errors.codes.VALIDATION_FAILED)).toBeInTheDocument();
    // The work is not thrown away by a request that failed.
    expect(strip()).toEqual(['Page 2, now 1 of 3', 'Page 1, now 2 of 3', 'Page 3, now 3 of 3']);
  });
});
