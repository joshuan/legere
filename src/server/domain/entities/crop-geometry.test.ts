import { describe, expect, it } from 'vitest';
import type { Crop } from '../../../shared/contracts/documents';
import {
  CropGeometryError,
  fullFrameCrop,
  mapPoint,
  planCrop,
  rectangleToCrop,
  sampleBilinear,
  warpPerspective,
  type Point,
  type Raster,
} from './crop-geometry';

// The geometry of docs/05 §5.6, checked against homographies whose answers are known in advance:
// the identity, a quarter turn, and a trapezoid whose corners and diagonals must land where
// projective geometry says they do.

function cropOf(points: Crop['points']): Crop {
  return { points };
}

function grayscale(width: number, height: number, values: number[]): Raster {
  return { data: Uint8Array.from(values), width, height, channels: 1 };
}

function expectPoint(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}

describe('planCrop', () => {
  it('the whole frame is the identity: same size, and every pixel comes from itself', () => {
    const plan = planCrop(fullFrameCrop(), { width: 120, height: 80 });

    expect(plan.size).toEqual({ width: 120, height: 80 });
    expectPoint(mapPoint(plan.toSource, 0, 0), { x: 0, y: 0 });
    expectPoint(mapPoint(plan.toSource, 120, 80), { x: 120, y: 80 });
    expectPoint(mapPoint(plan.toSource, 42.5, 17.5), { x: 42.5, y: 17.5 });
  });

  it('an axis-aligned rectangle keeps its own size and offset', () => {
    const crop = cropOf([
      [0.25, 0.5],
      [0.75, 0.5],
      [0.75, 1],
      [0.25, 1],
    ]);

    const plan = planCrop(crop, { width: 200, height: 100 });

    expect(plan.size).toEqual({ width: 100, height: 50 });
    expectPoint(mapPoint(plan.toSource, 0, 0), { x: 50, y: 50 });
    expectPoint(mapPoint(plan.toSource, 100, 50), { x: 150, y: 100 });
  });

  it('the output size comes from the quad edges, the longer of each opposite pair', () => {
    // A page shot from the side: the far edge is shorter than the near one, and nothing may be
    // squeezed to the shorter of the two (docs/05 §5.6).
    const crop = cropOf([
      [0.2, 0.1],
      [0.8, 0.2],
      [0.9, 0.9],
      [0.1, 0.8],
    ]);

    const plan = planCrop(crop, { width: 100, height: 100 });

    // Top edge (20,10)→(80,20) is √3700 ≈ 60.8; bottom (10,80)→(90,90) is √6500 ≈ 80.6.
    expect(plan.size.width).toBe(81);
    // Left (20,10)→(10,80) and right (80,20)→(90,90) are both √5000 ≈ 70.7.
    expect(plan.size.height).toBe(71);
  });

  it('a rotated quad is a known homography: the corners and the diagonal crossing land on it', () => {
    const crop = cropOf([
      [0.2, 0.2],
      [0.8, 0.3],
      [0.8, 0.7],
      [0.2, 0.6],
    ]);
    const source = { width: 100, height: 100 };

    const plan = planCrop(crop, source);
    const { width, height } = plan.size;

    // Four corner correspondences define a homography uniquely, so these four are the whole claim.
    expectPoint(mapPoint(plan.toSource, 0, 0), { x: 20, y: 20 });
    expectPoint(mapPoint(plan.toSource, width, 0), { x: 80, y: 30 });
    expectPoint(mapPoint(plan.toSource, width, height), { x: 80, y: 70 });
    expectPoint(mapPoint(plan.toSource, 0, height), { x: 20, y: 60 });

    // A projective map takes the crossing of the diagonals to the crossing of the diagonals: the
    // centre of the output rectangle is not the average of the corners, and this says so.
    const crossing = intersect(
      { x: 20, y: 20 },
      { x: 80, y: 70 },
      { x: 80, y: 30 },
      { x: 20, y: 60 },
    );
    expectPoint(mapPoint(plan.toSource, width / 2, height / 2), crossing);
  });

  it('refuses a quad with no area, a bow tie and a sliver', () => {
    const degenerate = cropOf([
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    const bowTie = cropOf([
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ]);
    const sliver = cropOf([
      [0, 0],
      [1, 0],
      [1, 0.001],
      [0, 0.001],
    ]);

    const source = { width: 100, height: 100 };
    expect(() => planCrop(degenerate, source)).toThrow(CropGeometryError);
    expect(() => planCrop(bowTie, source)).toThrow(CropGeometryError);
    expect(() => planCrop(sliver, source)).toThrow(CropGeometryError);
  });

  it('refuses three corners on one line', () => {
    const collinear = cropOf([
      [0, 0],
      [0.5, 0.5],
      [1, 1],
      [0, 1],
    ]);

    expect(() => planCrop(collinear, { width: 100, height: 100 })).toThrow(CropGeometryError);
  });

  it('refuses an image with no usable size', () => {
    expect(() => planCrop(fullFrameCrop(), { width: 0, height: 100 })).toThrow(CropGeometryError);
  });
});

describe('sampleBilinear', () => {
  const raster = grayscale(2, 2, [0, 100, 200, 40]);

  it('reads a pixel centre exactly', () => {
    expect(sampleBilinear(raster, 0.5, 0.5, 0)).toBeCloseTo(0, 6);
    expect(sampleBilinear(raster, 1.5, 0.5, 0)).toBeCloseTo(100, 6);
  });

  it('weighs the four neighbours in between', () => {
    expect(sampleBilinear(raster, 1, 0.5, 0)).toBeCloseTo(50, 6);
    expect(sampleBilinear(raster, 1, 1, 0)).toBeCloseTo((0 + 100 + 200 + 40) / 4, 6);
  });

  it('repeats the border rather than falling off it', () => {
    expect(sampleBilinear(raster, -5, -5, 0)).toBeCloseTo(0, 6);
    expect(sampleBilinear(raster, 99, 99, 0)).toBeCloseTo(40, 6);
  });
});

describe('warpPerspective', () => {
  it('the whole frame comes back byte for byte', () => {
    const source = grayscale(4, 2, [1, 2, 3, 4, 5, 6, 7, 8]);

    const warped = warpPerspective(source, planCrop(fullFrameCrop(), { width: 4, height: 2 }));

    expect(warped.width).toBe(4);
    expect(warped.height).toBe(2);
    expect([...warped.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('a quarter turn transposes the image', () => {
    const source = grayscale(4, 2, [1, 2, 3, 4, 5, 6, 7, 8]);
    // Top-left of the result is the top-right of the source: the page was photographed sideways.
    const crop = cropOf([
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]);

    const warped = warpPerspective(source, planCrop(crop, { width: 4, height: 2 }));

    expect({ width: warped.width, height: warped.height }).toEqual({ width: 2, height: 4 });
    expect([...warped.data]).toEqual([4, 8, 3, 7, 2, 6, 1, 5]);
  });

  it('carries every channel of a colour image', () => {
    const pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const source: Raster = {
      data: Uint8Array.from(pixels),
      width: 2,
      height: 2,
      channels: 3,
    };

    const warped = warpPerspective(source, planCrop(fullFrameCrop(), { width: 2, height: 2 }));

    expect(warped.channels).toBe(3);
    expect([...warped.data]).toEqual(pixels);
  });
});

describe('rectangleToCrop', () => {
  it('turns a pixel rectangle into the normalized quad, clockwise from the top-left', () => {
    const crop = rectangleToCrop(
      { left: 10, top: 20, width: 30, height: 40 },
      { width: 100, height: 200 },
    );

    expect(crop.points).toEqual([
      [0.1, 0.1],
      [0.4, 0.1],
      [0.4, 0.3],
      [0.1, 0.3],
    ]);
  });

  it('clamps a rectangle that reaches past the image', () => {
    const crop = rectangleToCrop(
      { left: -5, top: 0, width: 500, height: 500 },
      { width: 100, height: 100 },
    );

    expect(crop.points).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  });

  it('refuses an image with no usable size', () => {
    expect(() =>
      rectangleToCrop({ left: 0, top: 0, width: 1, height: 1 }, { width: 0, height: 0 }),
    ).toThrow(CropGeometryError);
  });
});

// Where two lines through the given pairs of points cross.
function intersect(a: Point, b: Point, c: Point, d: Point): Point {
  const denominator = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  const first = a.x * b.y - a.y * b.x;
  const second = c.x * d.y - c.y * d.x;
  return {
    x: (first * (c.x - d.x) - (a.x - b.x) * second) / denominator,
    y: (first * (c.y - d.y) - (a.y - b.y) * second) / denominator,
  };
}
