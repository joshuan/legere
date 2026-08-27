import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  cropSchema,
  rotationSchema,
  type Crop,
  type DocumentDetailDto,
  type DocumentFileDto,
  type DocumentPageDto,
  type Rotation,
} from '../../../shared/contracts/documents';

// What `PATCH /api/documents/:id/pages/:pageId` takes (docs/07 §7.3): how much of one page is paper
// and which way up it lies. Read back here so a test asserts against the shape the endpoint fixes
// rather than against whatever the editor happened to send.
const savedBodySchema = z.object({
  crop: cropSchema.nullable(),
  turn: rotationSchema.nullable(),
});
const savedBody = (body: unknown) => savedBodySchema.parse(body);
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { CropEditor } from './crop-editor';

// jsdom lays nothing out: `getBoundingClientRect()` answers with zeros for everything, so the one
// place the editor touches layout is a seam, and here it is driven with a known rendered size —
// 400 × 300 at (40, 20). That is what turns an arrow key into a fraction of the image.
const frame = vi.hoisted(() => ({ left: 40, top: 20, width: 400, height: 300 }));
vi.mock('./use-image-frame', () => ({
  NO_FRAME: { left: 0, top: 0, width: 0, height: 0 },
  useImageFrame: () => ({ frame, measure: () => undefined }),
}));

const DOCUMENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const FILE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const PAGE_ID = 'cccccccc-3333-4333-8333-333333333333';

const CROP: Crop = {
  points: [
    [0.1, 0.05],
    [0.9, 0.08],
    [0.92, 0.95],
    [0.08, 0.9],
  ],
};

// The page being cropped: an image is one page, and the crop and the turn are written on it
// (docs/03 §3.3.17, ADR-025).
function makePage(crop: Crop | null, turn: Rotation | null = null): DocumentPageDto {
  return {
    id: PAGE_ID,
    position: 0,
    fileId: FILE_ID,
    pageIndex: 0,
    turn,
    crop,
    cropSource: crop === null ? 'NONE' : 'MANUAL',
  };
}

function makeFile(crop: Crop | null, rotation: Rotation | null = null): DocumentFileDto {
  return {
    id: FILE_ID,
    position: 0,
    name: 'passport-01.jpg',
    mimeType: 'image/jpeg',
    ext: 'jpg',
    sizeBytes: '204800',
    origin: 'MANAGED',
    available: true,
    isImage: true,
    crop,
    cropSource: crop === null ? 'NONE' : 'MANUAL',
    rotation,
    pageOrder: null,
    pageRotations: null,
    pageCount: null,
    refs: [],
    storageKey: `files/${FILE_ID}/original.jpg`,
    earlierVersions: [],
  };
}

// What `PATCH …/files/:fileId` answers with: the whole document (docs/07 §7.3). The client
// validates it against the contract, so it has to be a real one.
const rebuilt: DocumentDetailDto = {
  id: DOCUMENT_ID,
  title: 'Passport',
  fileCount: 1,
  primaryExt: 'jpg',
  sizeBytes: '204800',
  pageCount: null,
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
  // An image is one page, and the crop is written on that page (docs/03 §3.3.17): the file row
  // beside it says the same thing, read off this entry.
  pages: [makePage(CROP)],
  files: [makeFile(CROP)],
  createdBy: null,
  extracted: null,
  extractedSummary: null,
};

// What the editor stores is stored on the **page**; the picture and the proposal are still read off
// the file, because those are about bytes (docs/07 §7.3).
const SAVE_PATH = `/api/documents/${DOCUMENT_ID}/pages/${PAGE_ID}`;
const FILE_PATH = `/api/documents/${DOCUMENT_ID}/files/${FILE_ID}`;
const SUGGESTION_PATH = `${FILE_PATH}/crop-suggestion`;

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

const corner = (index: number): string =>
  enMessages.viewer.crop.corner.replace('{index}', String(index));

const outline = (): string => screen.getByTestId('crop-outline').getAttribute('points') ?? '';

// Captures the body of the save so a test can read the four points it was actually sent.
function captureSave(): { body: () => unknown } {
  let received: unknown = null;
  server.use(
    http.patch(SAVE_PATH, async ({ request }) => {
      received = await request.json();
      return HttpResponse.json(envelope(rebuilt));
    }),
  );
  return { body: () => received };
}

function open(
  crop: Crop | null,
  turn: Rotation | null = null,
  file: DocumentFileDto = makeFile(crop, turn),
  onClose = vi.fn(),
): { onClose: ReturnType<typeof vi.fn> } {
  renderWithProviders(
    <CropEditor
      open
      documentId={DOCUMENT_ID}
      page={makePage(crop, turn)}
      file={file}
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe('CropEditor', () => {
  it('starts from the crop the page already has', () => {
    open(CROP);

    expect(screen.getByText(enMessages.viewer.crop.title)).toBeInTheDocument();
    expect(outline()).toBe('10,5 90,8 92,95 8,90');
    for (const index of [1, 2, 3, 4]) {
      expect(screen.getByRole('button', { name: corner(index) })).toBeInTheDocument();
    }
    expect(screen.getByAltText('passport-01.jpg')).toHaveAttribute('src', `${FILE_PATH}/content`);
  });

  it('starts from the whole image when the page has no crop', () => {
    open(null);

    expect(outline()).toBe('0,0 100,0 100,100 0,100');
  });

  it('drops the detected corners in and says the page was found', async () => {
    server.use(
      http.get(SUGGESTION_PATH, () =>
        HttpResponse.json(
          envelope({
            crop: {
              points: [
                [0.2, 0.1],
                [0.8, 0.12],
                [0.82, 0.9],
                [0.18, 0.88],
              ],
            },
            method: 'EDGES',
          }),
        ),
      ),
    );

    open(null);
    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.autoDetect }));

    expect(await screen.findByText(enMessages.viewer.crop.autoDetected)).toBeInTheDocument();
    expect(outline()).toBe('20,10 80,12 82,90 18,88');
    expect(screen.queryByText(enMessages.viewer.crop.autoFailed)).not.toBeInTheDocument();
  });

  it('says so when only the content box could be proposed, and still saves nothing by itself', async () => {
    let saves = 0;
    server.use(
      http.get(SUGGESTION_PATH, () =>
        HttpResponse.json(
          envelope({
            crop: {
              points: [
                [0.05, 0.05],
                [0.95, 0.05],
                [0.95, 0.95],
                [0.05, 0.95],
              ],
            },
            method: 'CONTENT_BOX',
          }),
        ),
      ),
      http.patch(SAVE_PATH, () => {
        saves += 1;
        return HttpResponse.json(envelope(rebuilt));
      }),
    );

    open(null);
    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.autoDetect }));

    expect(await screen.findByText(enMessages.viewer.crop.autoFailed)).toBeInTheDocument();
    expect(outline()).toBe('5,5 95,5 95,95 5,95');
    expect(saves).toBe(0);
  });

  it('nudges a focused corner by a pixel, and by ten with Shift', async () => {
    const save = captureSave();
    open(CROP);

    await userEvent.click(screen.getByRole('button', { name: corner(1) }));
    expect(screen.getByRole('button', { name: corner(1) })).toHaveFocus();

    // One pixel right of 400 rendered pixels, ten pixels down of 300.
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));
    await waitFor(() => expect(save.body()).not.toBeNull());

    const sent = savedBody(save.body()).crop;
    expect(sent).not.toBeNull();
    const moved = sent?.points[0] ?? [0, 0];
    expect(moved[0]).toBeCloseTo(0.1 + 1 / frame.width, 10);
    expect(moved[1]).toBeCloseTo(0.05 + 10 / frame.height, 10);
    // The other three corners stayed exactly where they were.
    expect(sent?.points[1]).toEqual([0.9, 0.08]);
    expect(sent?.points[2]).toEqual([0.92, 0.95]);
    expect(sent?.points[3]).toEqual([0.08, 0.9]);
  });

  it('saves the four points it was given, then closes on the answer', async () => {
    const save = captureSave();
    const { onClose } = open(CROP);

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

    // The turn travels with the crop, and a page nobody has turned sends the null it already has.
    await waitFor(() => expect(save.body()).toEqual({ crop: CROP, turn: null }));
    expect(await screen.findByText(enMessages.viewer.crop.saved)).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('clears the crop and sends null', async () => {
    const save = captureSave();
    const { onClose } = open(CROP);

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.reset }));
    expect(outline()).toBe('0,0 100,0 100,100 0,100');

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

    await waitFor(() => expect(save.body()).toEqual({ crop: null, turn: null }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // Which way up the paper lay, in the editor that already answers "which part of this"
  // (docs/11 §11.5c). The outline is drawn in the orientation on the screen, so a corner stays on
  // the bit of paper it was dragged onto; what is *stored* is still against the pixels that arrived.
  describe('the turn', () => {
    const button = (key: 'rotateLeft' | 'rotateRight' | 'mirror' | 'resetTurn'): HTMLElement =>
      screen.getByRole('button', { name: enMessages.viewer.crop[key] });

    it('turns what it draws, so the outline follows the page instead of staying behind', async () => {
      open(CROP);
      expect(outline()).toBe('10,5 90,8 92,95 8,90');

      await userEvent.click(button('rotateRight'));

      // A quarter turn clockwise sends (x, y) to (1 − y, x) — and renames the corners with it: the
      // one that was top-left is the top-right one now, so the list starts from what was bottom-left.
      expect(outline()).toBe('10,8 95,10 92,90 5,92');
    });

    it('sends the turn beside the crop, with the quadrilateral back in the pixels that arrived', async () => {
      const save = captureSave();
      open(CROP);

      await userEvent.click(button('rotateRight'));
      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

      await waitFor(() => expect(save.body()).not.toBeNull());
      const sent = savedBody(save.body());
      expect(sent.turn).toEqual({ quarterTurns: 1, mirrored: false });
      // 🔒 Untouched: the build applies the crop first and the turn after it (docs/05 §5.6).
      expect(sent.crop).toEqual(CROP);
    });

    it('opens on the turn the page already carries, drawing the page the way it will be read', () => {
      open(CROP, { quarterTurns: 1, mirrored: false });

      // The stored quadrilateral is against the pixels that arrived, so what is drawn is it, turned.
      expect(outline()).toBe('10,8 95,10 92,90 5,92');
    });

    it('mirrors, and takes the stored turn round the other way with it', async () => {
      const save = captureSave();
      open(CROP, { quarterTurns: 1, mirrored: false });

      await userEvent.click(button('mirror'));
      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

      await waitFor(() => expect(save.body()).not.toBeNull());
      const sent = savedBody(save.body());
      // The person flipped the page they were looking at; the stored value says the same thing in
      // the order it is defined in — mirror first, then the quarter turns.
      expect(sent.turn).toEqual({ quarterTurns: 3, mirrored: true });
      expect(sent.crop).toEqual(CROP);
    });

    it('sends null for Reset turn and puts the outline back where it started', async () => {
      const save = captureSave();
      open(CROP, { quarterTurns: 2, mirrored: false });

      await userEvent.click(button('resetTurn'));
      expect(outline()).toBe('10,5 90,8 92,95 8,90');

      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

      await waitFor(() => expect(save.body()).not.toBeNull());
      const sent = savedBody(save.body());
      // Nothing to undo: the turn was an instruction beside bytes nobody rewrote (docs/03 §3.3.16).
      expect(sent.turn).toBeNull();
      expect(sent.crop).toEqual(CROP);
    });

    it('offers nothing to reset on a page that reads the way it arrived', () => {
      open(CROP);

      expect(button('resetTurn')).toBeDisabled();
    });

    it('comes back to where it started after four presses', async () => {
      const save = captureSave();
      open(CROP);

      for (const _press of [0, 1, 2, 3]) await userEvent.click(button('rotateLeft'));
      expect(outline()).toBe('10,5 90,8 92,95 8,90');

      await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

      await waitFor(() => expect(save.body()).not.toBeNull());
      // A turn of nothing is not a turn: what goes out is the null a file that arrived this way up
      // already has (docs/03 §3.3.16).
      expect(savedBody(save.body()).turn).toBeNull();
    });
  });

  it('keeps the modal open and localizes the failure when the save is refused', async () => {
    server.use(
      http.patch(SAVE_PATH, () =>
        HttpResponse.json(errorEnvelope('INTERNAL', 'rebuild could not be enqueued'), {
          status: 500,
        }),
      ),
    );
    const { onClose } = open(CROP);

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

    expect(await screen.findByText(enMessages.errors.codes.INTERNAL)).toBeInTheDocument();
    expect(screen.queryByText('rebuild could not be enqueued')).not.toBeInTheDocument();
    expect(screen.getByText(enMessages.viewer.crop.title)).toBeInTheDocument();
    expect(screen.getByTestId('crop-outline')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
