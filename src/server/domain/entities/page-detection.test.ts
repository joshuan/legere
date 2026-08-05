import { describe, expect, it } from 'vitest';
import type { Crop } from '../../../shared/contracts/documents';
import { detectPageEdges, type GrayscaleRaster } from './page-detection';

// Synthetic pages, drawn here rather than loaded from a fixture: the detector's claim is about
// geometry, and geometry is exactly what a generated raster can state precisely (docs/05 §5.6).

const BACKGROUND = 24;
const PAGE = 236;

function blank(width: number, height: number, value: number): GrayscaleRaster {
  return { data: new Uint8Array(width * height).fill(value), width, height };
}

function fill(
  raster: GrayscaleRaster,
  value: number,
  covers: (x: number, y: number) => boolean,
): GrayscaleRaster {
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (covers(x, y)) raster.data[y * raster.width + x] = value;
    }
  }
  return raster;
}

// Corners in pixels, so a claim reads as "this many pixels off" rather than as a fraction.
function cornersOf(crop: Crop, raster: GrayscaleRaster): Array<[number, number]> {
  return crop.points.map(([x, y]) => [x * raster.width, y * raster.height]);
}

function expectCorners(
  actual: Array<[number, number]>,
  expected: Array<[number, number]>,
  tolerance: number,
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], index) => {
    const corner = expected[index] ?? [0, 0];
    expect(Math.abs(x - corner[0])).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(y - corner[1])).toBeLessThanOrEqual(tolerance);
  });
}

describe('detectPageEdges', () => {
  it('finds a bright page on a dark table', () => {
    const raster = fill(
      blank(200, 150, BACKGROUND),
      PAGE,
      (x, y) => x >= 40 && x < 160 && y >= 30 && y < 120,
    );

    const detected = detectPageEdges(raster);

    expect(detected?.method).toBe('EDGES');
    expect(detected).not.toBeNull();
    expectCorners(
      cornersOf(
        detected?.crop ?? {
          points: [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        },
        raster,
      ),
      [
        [40, 30],
        [160, 30],
        [160, 120],
        [40, 120],
      ],
      2,
    );
  });

  it('finds a page lying at an angle, and says which corner is which', () => {
    const angle = (10 * Math.PI) / 180;
    const centre = { x: 110, y: 85 };
    const half = { x: 62, y: 46 };
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const raster = fill(blank(220, 170, BACKGROUND), PAGE, (x, y) => {
      const dx = x - centre.x;
      const dy = y - centre.y;
      // Back into the page's own frame: inside the rectangle there means inside the page here.
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      return Math.abs(u) <= half.x && Math.abs(v) <= half.y;
    });

    const detected = detectPageEdges(raster);

    expect(detected).not.toBeNull();
    const corner = (u: number, v: number): [number, number] => [
      centre.x + u * cos - v * sin,
      centre.y + u * sin + v * cos,
    ];
    expectCorners(
      cornersOf(
        detected?.crop ?? {
          points: [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        },
        raster,
      ),
      [
        corner(-half.x, -half.y),
        corner(half.x, -half.y),
        corner(half.x, half.y),
        corner(-half.x, half.y),
      ],
      3,
    );
  });

  it('answers nothing for a page that fills the frame', () => {
    expect(detectPageEdges(blank(200, 150, PAGE))).toBeNull();
  });

  it('answers nothing for a page whose edges are the picture edges', () => {
    // A photograph cropped to the page: the only lines are its own printed rules, and a quad that
    // covers the whole frame is the frame rather than a page (docs/05 §5.6).
    const raster = fill(blank(200, 150, PAGE), BACKGROUND, (_x, y) => y === 4 || y === 145);

    expect(detectPageEdges(raster)).toBeNull();
  });

  it('answers nothing for noise', () => {
    const raster = blank(200, 150, 0);
    const random = seeded(20260805);
    for (let index = 0; index < raster.data.length; index += 1) {
      raster.data[index] = Math.floor(random() * 256);
    }

    expect(detectPageEdges(raster)).toBeNull();
  });

  it('answers nothing for a photograph of nothing', () => {
    expect(detectPageEdges(blank(200, 150, BACKGROUND))).toBeNull();
  });

  it('answers nothing for a raster too small to hold a page', () => {
    expect(detectPageEdges(blank(10, 10, BACKGROUND))).toBeNull();
  });

  it('answers nothing when only one edge of the page is visible', () => {
    // A single stripe: one strong line, and no second one far enough from it to be the far edge.
    const raster = fill(blank(200, 150, BACKGROUND), PAGE, (_x, y) => y >= 70 && y < 74);

    expect(detectPageEdges(raster)).toBeNull();
  });
});

// A deterministic pseudo-random source: a flaky "is this noise?" test would be worse than none.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
