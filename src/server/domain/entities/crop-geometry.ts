import type { Crop } from '../../../shared/contracts/documents';

// The geometry of a crop (docs/05 §5.6): a photograph of a page taken from the side is a
// quadrilateral, not a rectangle, so straightening it is a perspective transform rather than a
// cut-out. Pure arithmetic — no image library, no I/O — so it can be reasoned about and tested
// against homographies whose answer is known in advance.

export class CropGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CropGeometryError';
  }
}

export type Size = { width: number; height: number };

export type Point = { x: number; y: number };

// The four corners in pixels, clockwise from the top-left — the order the crop is stored in
// (docs/03 §3.3.16).
export type Quad = readonly [Point, Point, Point, Point];

// A 3×3 projective transform, row-major: [a b c, d e f, g h i]. Applied to (x, y, 1) and divided
// through by the third component.
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

// What building one cropped page needs: how big the result is, and where each of its pixels comes
// from in the original. The mapping goes output → source, because that is the direction a resampler
// walks: every output pixel is asked where it was, so none of them is left unwritten.
export type CropPlan = {
  size: Size;
  toSource: Homography;
};

// Raw interleaved pixels, the shape `sharp` hands over and takes back.
export type Raster = {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
};

// A side shorter than this is a line, not a page: there is nothing to resample along it, and the
// result would be a document one pixel wide.
const MIN_SIDE_PX = 2;

// The quad has to enclose something. A crop this small is a mis-drag or a broken client, and
// applying it would silently replace the document with a speck.
const MIN_AREA_RATIO = 1e-4;

// Anything below this is zero as far as the arithmetic below is concerned; the numbers are pixel
// coordinates of images at most a few thousand pixels wide.
const EPSILON = 1e-9;

// The plan for one crop: the output rectangle's size comes from the quad's own edges — the longer of
// the two opposite sides, so nothing is squeezed — and the homography maps that rectangle back onto
// the quad (docs/05 §5.6).
export function planCrop(crop: Crop, source: Size): CropPlan {
  if (!isPositiveSize(source)) {
    throw new CropGeometryError('The source image has no usable size');
  }

  const [first, second, third, fourth] = crop.points;
  const topLeft = toPixels(first, source);
  const topRight = toPixels(second, source);
  const bottomRight = toPixels(third, source);
  const bottomLeft = toPixels(fourth, source);

  const corners: Quad = [topLeft, topRight, bottomRight, bottomLeft];
  if (!isConvexQuad(corners)) {
    throw new CropGeometryError('The crop is not a convex quadrilateral');
  }
  if (areaOf(corners) < MIN_AREA_RATIO * source.width * source.height) {
    throw new CropGeometryError('The crop encloses too little of the image');
  }

  // The two opposite sides of a photographed page are never quite equal — that is what perspective
  // does — so the wider of each pair decides, and nothing in the result is compressed.
  const width = Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight));
  const height = Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight));
  if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) {
    throw new CropGeometryError('The crop is too small to be a page');
  }

  const size = { width: Math.round(width), height: Math.round(height) };
  const unitToQuad = unitSquareToQuad(corners);
  // Output pixel coordinates are turned into unit-square ones on the way in, which is one matrix
  // multiplication by a scale — folded into the columns rather than done per pixel.
  return {
    size,
    toSource: [
      unitToQuad[0] / size.width,
      unitToQuad[1] / size.height,
      unitToQuad[2],
      unitToQuad[3] / size.width,
      unitToQuad[4] / size.height,
      unitToQuad[5],
      unitToQuad[6] / size.width,
      unitToQuad[7] / size.height,
      unitToQuad[8],
    ],
  };
}

// (x, y, 1) through the matrix, divided back into the plane.
export function mapPoint(transform: Homography, x: number, y: number): Point {
  const w = transform[6] * x + transform[7] * y + transform[8];
  if (Math.abs(w) < EPSILON) {
    throw new CropGeometryError('The crop maps a point to infinity');
  }
  return {
    x: (transform[0] * x + transform[1] * y + transform[2]) / w,
    y: (transform[3] * x + transform[4] * y + transform[5]) / w,
  };
}

// One channel of one pixel, read between pixels. A resampled page whose pixels are picked by
// rounding looks like a page photographed through a screen door, so the four neighbours are weighed
// instead. Coordinates are in pixel centres: (0.5, 0.5) is the middle of the top-left pixel.
export function sampleBilinear(raster: Raster, x: number, y: number, channel: number): number {
  // Continuous coordinates measured from pixel centres, clamped so the border repeats rather than
  // wrapping or going black.
  const px = clamp(x - 0.5, 0, raster.width - 1);
  const py = clamp(y - 0.5, 0, raster.height - 1);

  const left = Math.floor(px);
  const top = Math.floor(py);
  const right = Math.min(left + 1, raster.width - 1);
  const bottom = Math.min(top + 1, raster.height - 1);
  const fx = px - left;
  const fy = py - top;

  const topLeft = at(raster, left, top, channel);
  const topRight = at(raster, right, top, channel);
  const bottomLeft = at(raster, left, bottom, channel);
  const bottomRight = at(raster, right, bottom, channel);

  const upper = topLeft + (topRight - topLeft) * fx;
  const lower = bottomLeft + (bottomRight - bottomLeft) * fx;
  return upper + (lower - upper) * fy;
}

// The straightened page: every output pixel asks the plan where it came from and samples there
// (docs/05 §5.6). The channel count travels through untouched, so a grayscale scan stays grayscale.
export function warpPerspective(source: Raster, plan: CropPlan): Raster {
  const { width, height } = plan.size;
  const channels = source.channels;
  const data = new Uint8Array(width * height * channels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = mapPoint(plan.toSource, x + 0.5, y + 0.5);
      const offset = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        data[offset + channel] = Math.round(
          clamp(sampleBilinear(source, from.x, from.y, channel), 0, 255),
        );
      }
    }
  }

  return { data, width, height, channels };
}

// The whole image as a crop: what an uncropped file means when something needs a quad anyway.
export function fullFrameCrop(): Crop {
  return {
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  };
}

// A rectangle in pixels → the normalized quad the product stores (docs/03 §3.3.16). Used by the
// content-box fallback, which is a rectangle by construction.
export function rectangleToCrop(
  rectangle: { left: number; top: number; width: number; height: number },
  source: Size,
): Crop {
  if (!isPositiveSize(source)) {
    throw new CropGeometryError('The source image has no usable size');
  }
  const left = clamp(rectangle.left / source.width, 0, 1);
  const top = clamp(rectangle.top / source.height, 0, 1);
  const right = clamp((rectangle.left + rectangle.width) / source.width, 0, 1);
  const bottom = clamp((rectangle.top + rectangle.height) / source.height, 0, 1);

  return {
    points: [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
  };
}

// The classic unit-square → quadrilateral homography (Heckbert). The corners are given clockwise
// from the top-left, which is the order (0,0), (1,0), (1,1), (0,1) of the unit square.
function unitSquareToQuad(corners: Quad): Homography {
  const [p0, p1, p2, p3] = corners;

  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  // A parallelogram — which includes every plain rectangle — has no perspective at all, and the
  // general formula divides by zero for it.
  if (Math.abs(sx) < EPSILON && Math.abs(sy) < EPSILON) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < EPSILON) {
    throw new CropGeometryError('The crop has three corners on one line');
  }

  const g = (sx * dy2 - dx2 * sy) / denominator;
  const h = (dx1 * sy - sx * dy1) / denominator;

  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ];
}

// Convex and wound the one way: a "quad" whose sides cross is a bow tie, and warping through it
// folds the page onto itself.
function isConvexQuad(corners: Quad): boolean {
  const [a, b, c, d] = corners;
  const turns = [turn(a, b, c), turn(b, c, d), turn(c, d, a), turn(d, a, b)];
  if (turns.some((value) => Math.abs(value) < EPSILON)) return false;
  return turns.every((value) => value > 0) || turns.every((value) => value < 0);
}

// Which way the path a → b → c bends; the sign is the winding, the magnitude twice the triangle.
function turn(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

// Shoelace, absolute — the winding is checked separately.
function areaOf(corners: Quad): number {
  const [a, b, c, d] = corners;
  const sum =
    a.x * b.y -
    b.x * a.y +
    (b.x * c.y - c.x * b.y) +
    (c.x * d.y - d.x * c.y) +
    (d.x * a.y - a.x * d.y);
  return Math.abs(sum) / 2;
}

function toPixels(point: readonly [number, number], source: Size): Point {
  return { x: point[0] * source.width, y: point[1] * source.height };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function isPositiveSize(size: Size): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width >= 1 &&
    size.height >= 1
  );
}

function at(raster: Raster, x: number, y: number, channel: number): number {
  return raster.data[(y * raster.width + x) * raster.channels + channel] ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
