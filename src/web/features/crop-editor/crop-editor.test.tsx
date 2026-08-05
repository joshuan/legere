import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Crop, DocumentDetailDto, DocumentFileDto } from '../../../shared/contracts/documents';
import { updateDocumentFileRequestSchema } from '../../../shared/contracts/files';
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

const CROP: Crop = {
  points: [
    [0.1, 0.05],
    [0.9, 0.08],
    [0.92, 0.95],
    [0.08, 0.9],
  ],
};

function makeFile(crop: Crop | null): DocumentFileDto {
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
    refs: [],
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
  files: [makeFile(CROP)],
  createdBy: null,
};

const SAVE_PATH = `/api/documents/${DOCUMENT_ID}/files/${FILE_ID}`;
const SUGGESTION_PATH = `${SAVE_PATH}/crop-suggestion`;

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

function open(file: DocumentFileDto, onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  renderWithProviders(<CropEditor open documentId={DOCUMENT_ID} file={file} onClose={onClose} />);
  return { onClose };
}

describe('CropEditor', () => {
  it('starts from the crop the file already has', () => {
    open(makeFile(CROP));

    expect(screen.getByText(enMessages.viewer.crop.title)).toBeInTheDocument();
    expect(outline()).toBe('10,5 90,8 92,95 8,90');
    for (const index of [1, 2, 3, 4]) {
      expect(screen.getByRole('button', { name: corner(index) })).toBeInTheDocument();
    }
    expect(screen.getByAltText('passport-01.jpg')).toHaveAttribute('src', `${SAVE_PATH}/content`);
  });

  it('starts from the whole image when the file has no crop', () => {
    open(makeFile(null));

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

    open(makeFile(null));
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

    open(makeFile(null));
    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.autoDetect }));

    expect(await screen.findByText(enMessages.viewer.crop.autoFailed)).toBeInTheDocument();
    expect(outline()).toBe('5,5 95,5 95,95 5,95');
    expect(saves).toBe(0);
  });

  it('nudges a focused corner by a pixel, and by ten with Shift', async () => {
    const save = captureSave();
    open(makeFile(CROP));

    await userEvent.click(screen.getByRole('button', { name: corner(1) }));
    expect(screen.getByRole('button', { name: corner(1) })).toHaveFocus();

    // One pixel right of 400 rendered pixels, ten pixels down of 300.
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));
    await waitFor(() => expect(save.body()).not.toBeNull());

    const sent = updateDocumentFileRequestSchema.parse(save.body()).crop;
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
    const { onClose } = open(makeFile(CROP));

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

    await waitFor(() => expect(save.body()).toEqual({ crop: CROP }));
    expect(await screen.findByText(enMessages.viewer.crop.saved)).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('clears the crop and sends null', async () => {
    const save = captureSave();
    const { onClose } = open(makeFile(CROP));

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.reset }));
    expect(outline()).toBe('0,0 100,0 100,100 0,100');

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

    await waitFor(() => expect(save.body()).toEqual({ crop: null }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps the modal open and localizes the failure when the save is refused', async () => {
    server.use(
      http.patch(SAVE_PATH, () =>
        HttpResponse.json(errorEnvelope('INTERNAL', 'rebuild could not be enqueued'), {
          status: 500,
        }),
      ),
    );
    const { onClose } = open(makeFile(CROP));

    await userEvent.click(screen.getByRole('button', { name: enMessages.viewer.crop.save }));

    expect(await screen.findByText(enMessages.errors.codes.INTERNAL)).toBeInTheDocument();
    expect(screen.queryByText('rebuild could not be enqueued')).not.toBeInTheDocument();
    expect(screen.getByText(enMessages.viewer.crop.title)).toBeInTheDocument();
    expect(screen.getByTestId('crop-outline')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
