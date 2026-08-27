import '@testing-library/jest-dom/vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Crop, DocumentFileDto, DocumentPageDto } from '../../../shared/contracts/documents';
import { createApiMock } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { CropEditor } from './crop-editor';

// The loupe of docs/11 §11.5c. Same seam as `crop-editor.test.tsx`: jsdom lays nothing out, so the
// rendered frame is driven — 400 × 300 for a source that is 3000 × 2000, which is exactly the case
// the loupe exists for (a photographed A4 sheet shown at a fraction of its resolution).
const frame = vi.hoisted(() => ({ left: 40, top: 20, width: 400, height: 300 }));
vi.mock('./use-image-frame', () => ({
  NO_FRAME: { left: 0, top: 0, width: 0, height: 0 },
  useImageFrame: () => ({ frame, measure: () => undefined }),
}));

const NATURAL = { width: 3000, height: 2000 };

const DOCUMENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const FILE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const PAGE_ID = 'cccccccc-3333-4333-8333-333333333333';
const CONTENT_PATH = `/api/documents/${DOCUMENT_ID}/files/${FILE_ID}/content`;

const CROP: Crop = {
  points: [
    [0.1, 0.05],
    [0.9, 0.08],
    [0.92, 0.95],
    [0.08, 0.9],
  ],
};

const file: DocumentFileDto = {
  id: FILE_ID,
  position: 0,
  name: 'passport-01.jpg',
  mimeType: 'image/jpeg',
  ext: 'jpg',
  sizeBytes: '204800',
  origin: 'MANAGED',
  available: true,
  isImage: true,
  crop: CROP,
  cropSource: 'MANUAL',
  rotation: null,
  pageOrder: null,
  pageRotations: null,
  pageCount: null,
  refs: [],
  storageKey: `files/${FILE_ID}/original.jpg`,
  earlierVersions: [],
};

// An image is one page, and the crop lives on it (docs/03 §3.3.17).
const page: DocumentPageDto = {
  id: PAGE_ID,
  position: 0,
  fileId: FILE_ID,
  pageIndex: 0,
  turn: null,
  crop: CROP,
  cropSource: 'MANUAL',
};

const server = createApiMock();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  // jsdom draws nothing: its own `getContext` answers null after logging that it cannot. The loupe
  // already treats a missing context as "no picture, still an outline", so this only keeps the run
  // quiet — the component takes exactly the path it takes in jsdom without it.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  vi.restoreAllMocks();
  server.close();
});

const corner = (index: number): string =>
  enMessages.viewer.crop.corner.replace('{index}', String(index));

const handle = (index: number): HTMLElement => screen.getByRole('button', { name: corner(index) });

// The loupe magnifies the image the modal already loaded, so it needs the size that image would
// have reported. jsdom never loads one, hence the two properties and the load event by hand.
function openEditor(): void {
  renderWithProviders(
    <CropEditor open documentId={DOCUMENT_ID} page={page} file={file} onClose={vi.fn()} />,
  );
  const image = screen.getByAltText('passport-01.jpg');
  Object.defineProperty(image, 'naturalWidth', { value: NATURAL.width, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: NATURAL.height, configurable: true });
  fireEvent.load(image);
}

// The four corners of a polygon, as numbers, in whatever units that polygon is drawn in.
function polygon(testId: string): number[][] {
  const points = screen.getByTestId(testId).getAttribute('points') ?? '';
  return points.split(' ').map((pair) => pair.split(',').map(Number));
}

function edgeOf(corners: number[][]): number {
  return (corners[1]?.[0] ?? 0) - (corners[0]?.[0] ?? 0);
}

describe('CropEditor loupe', () => {
  it('watches the corner under the pointer and lets go of it on release', () => {
    openEditor();
    expect(screen.queryByTestId('crop-loupe')).not.toBeInTheDocument();

    fireEvent.pointerDown(handle(1), { pointerId: 1 });

    // The corner sits at (40, 15) of the rendered 400 × 300 image; the loupe stands beside it —
    // to the right by the gap, and below because there is no room above.
    expect(screen.getByTestId('crop-loupe')).toHaveStyle({ left: '64px', top: '39px' });
    expect(screen.getByTestId('crop-loupe-crosshair')).toBeInTheDocument();

    fireEvent.pointerUp(handle(1), { pointerId: 1 });

    expect(screen.queryByTestId('crop-loupe')).not.toBeInTheDocument();
  });

  it('flips to the other side of a corner near the edge, and stays inside the image', () => {
    openEditor();

    fireEvent.pointerDown(handle(2), { pointerId: 1 });

    // (360, 24): a loupe to the right would hang off the image, so it goes to the left instead.
    const loupe = screen.getByTestId('crop-loupe');
    expect(loupe).toHaveStyle({ left: '176px', top: '48px' });
  });

  it('shows while a focused handle is being nudged, and follows it', async () => {
    openEditor();

    await userEvent.click(handle(1));
    expect(handle(1)).toHaveFocus();
    // The click placed the corner and released it: nothing is being placed right now.
    expect(screen.queryByTestId('crop-loupe')).not.toBeInTheDocument();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('crop-loupe')).toHaveStyle({ left: '65px' });

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('crop-loupe')).toHaveStyle({ left: '66px' });

    // Leaving the handle ends the nudging, and the loupe with it.
    await userEvent.tab();
    expect(screen.queryByTestId('crop-loupe')).not.toBeInTheDocument();
  });

  it('magnifies past the frame the modal shows, up to the resolution of the source', () => {
    openEditor();

    fireEvent.pointerDown(handle(1), { pointerId: 1 });

    // The top edge of the crop: 0.8 of the image wide, in the modal and through the loupe.
    const onScreen = (edgeOf(polygon('crop-outline')) / 100) * frame.width;
    const throughTheLoupe = edgeOf(polygon('crop-loupe-outline'));

    expect(onScreen).toBeCloseTo(320, 6);
    // One source pixel is at least one pixel of the loupe: the modal scales the image down, the
    // loupe does not.
    expect(throughTheLoupe).toBeCloseTo(0.8 * NATURAL.width, 6);
    expect(throughTheLoupe / onScreen).toBeCloseTo(NATURAL.width / frame.width, 6);
    expect(throughTheLoupe / onScreen).toBeGreaterThan(1);
  });

  it('draws from the image the editor already loaded, and fetches nothing of its own', () => {
    openEditor();

    fireEvent.pointerDown(handle(1), { pointerId: 1 });

    const loupe = screen.getByTestId('crop-loupe');
    expect(loupe.querySelector('canvas')).not.toBeNull();
    // No second element pointed at the same bytes: one <img>, magnified onto a canvas.
    expect(loupe.querySelector('img')).toBeNull();
    expect(document.querySelectorAll(`img[src="${CONTENT_PATH}"]`)).toHaveLength(1);
  });

  it('says nothing until the image has said how large it is', () => {
    renderWithProviders(
      <CropEditor open documentId={DOCUMENT_ID} page={page} file={file} onClose={vi.fn()} />,
    );

    fireEvent.pointerDown(handle(1), { pointerId: 1 });

    expect(screen.queryByTestId('crop-loupe')).not.toBeInTheDocument();
  });
});
