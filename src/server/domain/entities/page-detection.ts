import type { Crop } from '../../../shared/contracts/documents';
import type { Point, Quad } from './crop-geometry';

// Finding the page inside a photograph of it (docs/05 §5.6): Sobel for where the brightness turns,
// a Hough transform for the straight lines that turn is made of, and the four intersections of the
// two strongest well-separated near-horizontal and near-vertical lines. Pure arithmetic over a
// grayscale raster — the downscaling and the decoding belong to the image tool.
//
// The answer is a *proposal*. When nothing convincing is there — a page filling the frame edge to
// edge, a photograph of a wall — this returns null and the caller falls back to the content
// bounding box.

export type GrayscaleRaster = {
  data: Uint8Array;
  width: number;
  height: number;
};

export type PageDetection = {
  crop: Crop;
  method: 'EDGES';
};

// How far from square a page may lie and still be recognised as one. Beyond this the photograph is
// not of a page on a table but of something else entirely, and the lines found would be furniture.
const ANGLE_TOLERANCE_DEG = 35;
const ANGLE_STEP_DEG = 1;

// A raster smaller than this has no room for a page and a border around it.
const MIN_DIMENSION = 24;

// Gradient magnitudes above the mean by this many standard deviations are edges. Adaptive rather
// than fixed: a photograph in poor light has weaker edges everywhere, and its page is no less real.
const EDGE_SIGMA = 2;
// …but never below this. In an image with no edges at all the mean and the deviation are both tiny,
// and every speck of sensor noise would qualify.
const MIN_EDGE_MAGNITUDE = 24;

// A line has to be voted for by this share of the span it crosses. Measured rather than guessed: on
// a 200×150 raster the edges of a drawn page poll 1.2–1.3 of the span (an edge votes twice, once
// from each side of the brightness step) and the best line in a field of pure noise polls 0.22. A
// third of the span sits between the two with room to spare in both directions.
const MIN_VOTES_FRACTION = 0.35;

// The opposite edges of a page are at least this far apart, as a share of the frame. Without it the
// two "strongest" lines are the two sides of one thick edge, and the page comes out a sliver.
const MIN_SEPARATION_FRACTION = 0.15;

// |sin(θ₂ − θ₁)| of the two families. Below this the horizontal and vertical lines are nearly
// parallel and their intersection is somewhere off in the distance.
const MIN_PERPENDICULARITY = 0.3;

// A quad covering nearly the whole frame is not a page that was found; it is the frame. The content
// box says the same thing more honestly (docs/05 §5.6).
const MAX_AREA_RATIO = 0.98;
// And one covering nearly none of it is a stamp, a shadow or a coincidence.
const MIN_AREA_RATIO = 0.05;

// A corner may land this far outside the frame — a page whose edge runs off the picture — before
// the answer stops being about the page at all.
const MAX_OVERSHOOT_RATIO = 0.2;

const MIN_EDGE_POINTS = 32;

type Line = {
  cos: number;
  sin: number;
  rho: number;
  votes: number;
};

type EdgePoints = {
  xs: readonly number[];
  ys: readonly number[];
};

// The page, or null when this photograph does not convincingly hold one (docs/05 §5.6).
export function detectPageEdges(raster: GrayscaleRaster): PageDetection | null {
  if (raster.width < MIN_DIMENSION || raster.height < MIN_DIMENSION) return null;

  const points = edgePoints(raster);
  if (points.xs.length < MIN_EDGE_POINTS) return null;

  // Horizontal lines are found across the width and separated down the height; the vertical family
  // is the same claim turned ninety degrees.
  const horizontal = strongestPair(points, raster, Math.PI / 2, raster.width, raster.height);
  const vertical = strongestPair(points, raster, 0, raster.height, raster.width);
  if (horizontal === null || vertical === null) return null;

  const quad = quadOf(horizontal, vertical);
  if (quad === null) return null;
  if (!isPlausiblePage(quad, raster)) return null;

  return { crop: toCrop(quad, raster), method: 'EDGES' };
}

// Sobel, then the pixels whose gradient stands out from the rest of the picture. The magnitudes are
// not kept: what the Hough transform needs is where the edges are, not how strong each one was.
function edgePoints(raster: GrayscaleRaster): EdgePoints {
  const { width, height } = raster;
  const magnitudes = new Float32Array(width * height);

  let sum = 0;
  let sumOfSquares = 0;
  let counted = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = at(raster, x - 1, y - 1);
      const top = at(raster, x, y - 1);
      const topRight = at(raster, x + 1, y - 1);
      const left = at(raster, x - 1, y);
      const right = at(raster, x + 1, y);
      const bottomLeft = at(raster, x - 1, y + 1);
      const bottom = at(raster, x, y + 1);
      const bottomRight = at(raster, x + 1, y + 1);

      const gx = topRight + 2 * right + bottomRight - (topLeft + 2 * left + bottomLeft);
      const gy = bottomLeft + 2 * bottom + bottomRight - (topLeft + 2 * top + topRight);
      const magnitude = Math.hypot(gx, gy);

      magnitudes[y * width + x] = magnitude;
      sum += magnitude;
      sumOfSquares += magnitude * magnitude;
      counted += 1;
    }
  }

  if (counted === 0) return { xs: [], ys: [] };

  const mean = sum / counted;
  const variance = Math.max(0, sumOfSquares / counted - mean * mean);
  const threshold = Math.max(mean + EDGE_SIGMA * Math.sqrt(variance), MIN_EDGE_MAGNITUDE);

  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if ((magnitudes[y * width + x] ?? 0) < threshold) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  return { xs, ys };
}

// The two strongest lines of one family — near-horizontal or near-vertical — that are far enough
// apart to be opposite edges of the same page rather than two readings of one edge.
function strongestPair(
  points: EdgePoints,
  raster: GrayscaleRaster,
  centreAngle: number,
  span: number,
  separationScale: number,
): [Line, Line] | null {
  const angles = anglesAround(centreAngle);
  const cosines = angles.map((angle) => Math.cos(angle));
  const sines = angles.map((angle) => Math.sin(angle));

  const rhoOffset = Math.ceil(Math.hypot(raster.width, raster.height));
  const rhoCount = 2 * rhoOffset + 1;
  const accumulator = new Int32Array(angles.length * rhoCount);

  for (let index = 0; index < points.xs.length; index += 1) {
    const x = points.xs[index] ?? 0;
    const y = points.ys[index] ?? 0;
    for (let angle = 0; angle < angles.length; angle += 1) {
      const rho = x * (cosines[angle] ?? 0) + y * (sines[angle] ?? 0);
      const cell = angle * rhoCount + Math.round(rho) + rhoOffset;
      accumulator[cell] = (accumulator[cell] ?? 0) + 1;
    }
  }

  const minVotes = MIN_VOTES_FRACTION * span;
  const minSeparation = MIN_SEPARATION_FRACTION * separationScale;

  const first = bestCell(accumulator, angles.length, rhoCount, rhoOffset, () => true);
  if (first === null || first.votes < minVotes) return null;

  const second = bestCell(
    accumulator,
    angles.length,
    rhoCount,
    rhoOffset,
    (rho) => Math.abs(rho - first.rho) >= minSeparation,
  );
  if (second === null || second.votes < minVotes) return null;

  return [lineOf(first, cosines, sines), lineOf(second, cosines, sines)];
}

type Cell = { angle: number; rho: number; votes: number };

// The best (angle, ρ) cell the filter accepts. Votes are counted over three neighbouring ρ bins,
// because a line one degree off the grid lands half in one bin and half in the next, and a page
// edge should not lose to quantization.
function bestCell(
  accumulator: Int32Array,
  angleCount: number,
  rhoCount: number,
  rhoOffset: number,
  accepts: (rho: number) => boolean,
): Cell | null {
  let best: Cell | null = null;

  for (let angle = 0; angle < angleCount; angle += 1) {
    const base = angle * rhoCount;
    for (let bin = 1; bin < rhoCount - 1; bin += 1) {
      const rho = bin - rhoOffset;
      if (!accepts(rho)) continue;
      const votes =
        (accumulator[base + bin - 1] ?? 0) +
        (accumulator[base + bin] ?? 0) +
        (accumulator[base + bin + 1] ?? 0);
      if (votes === 0) continue;
      if (best === null || votes > best.votes) best = { angle, rho, votes };
    }
  }

  return best;
}

function lineOf(cell: Cell, cosines: readonly number[], sines: readonly number[]): Line {
  return {
    cos: cosines[cell.angle] ?? 0,
    sin: sines[cell.angle] ?? 0,
    rho: cell.rho,
    votes: cell.votes,
  };
}

function anglesAround(centre: number): number[] {
  const step = (ANGLE_STEP_DEG * Math.PI) / 180;
  const tolerance = (ANGLE_TOLERANCE_DEG * Math.PI) / 180;
  const angles: number[] = [];
  for (let angle = centre - tolerance; angle <= centre + tolerance + 1e-9; angle += step) {
    angles.push(angle);
  }
  return angles;
}

// The four corners: each horizontal line crossed with each vertical one, put in the order a crop is
// stored in — clockwise from the top-left (docs/03 §3.3.16).
function quadOf(horizontal: [Line, Line], vertical: [Line, Line]): Quad | null {
  const corners: Point[] = [];
  for (const across of horizontal) {
    for (const down of vertical) {
      const corner = intersect(across, down);
      if (corner === null) return null;
      corners.push(corner);
    }
  }
  return orderClockwise(corners);
}

function intersect(a: Line, b: Line): Point | null {
  const determinant = a.cos * b.sin - a.sin * b.cos;
  if (Math.abs(determinant) < MIN_PERPENDICULARITY) return null;
  return {
    x: (a.rho * b.sin - a.sin * b.rho) / determinant,
    y: (a.cos * b.rho - a.rho * b.cos) / determinant,
  };
}

// Around the centre, then rotated so it starts at the corner nearest the origin. In image
// coordinates — y downwards — increasing angle is clockwise, which is the order the product stores.
function orderClockwise(corners: readonly Point[]): Quad | null {
  if (corners.length !== 4) return null;

  const centreX = corners.reduce((total, corner) => total + corner.x, 0) / corners.length;
  const centreY = corners.reduce((total, corner) => total + corner.y, 0) / corners.length;

  const sorted = [...corners].sort(
    (a, b) => Math.atan2(a.y - centreY, a.x - centreX) - Math.atan2(b.y - centreY, b.x - centreX),
  );

  let start = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const candidate = sorted[index];
    const current = sorted[start];
    if (candidate === undefined || current === undefined) return null;
    if (candidate.x + candidate.y < current.x + current.y) start = index;
  }

  const rotated = [
    sorted[start % 4],
    sorted[(start + 1) % 4],
    sorted[(start + 2) % 4],
    sorted[(start + 3) % 4],
  ];
  const [first, second, third, fourth] = rotated;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null;
  }
  return [first, second, third, fourth];
}

// Is this a page, or four lines that happened to cross? It has to sit inside the picture, take up a
// believable part of it, and not simply be the picture.
function isPlausiblePage(quad: Quad, raster: GrayscaleRaster): boolean {
  const overshootX = MAX_OVERSHOOT_RATIO * raster.width;
  const overshootY = MAX_OVERSHOOT_RATIO * raster.height;
  for (const corner of quad) {
    if (corner.x < -overshootX || corner.x > raster.width + overshootX) return false;
    if (corner.y < -overshootY || corner.y > raster.height + overshootY) return false;
  }

  const frame = raster.width * raster.height;
  const area = areaOf(quad);
  return area >= MIN_AREA_RATIO * frame && area <= MAX_AREA_RATIO * frame;
}

function areaOf(quad: Quad): number {
  const [a, b, c, d] = quad;
  const sum =
    a.x * b.y -
    b.x * a.y +
    (b.x * c.y - c.x * b.y) +
    (c.x * d.y - d.x * c.y) +
    (d.x * a.y - a.x * d.y);
  return Math.abs(sum) / 2;
}

// Pixels → the 0…1 the crop is stored in, clamped to the frame: a corner just outside the picture
// is a real corner of the page, and the part of it that was photographed is what can be cropped.
function toCrop(quad: Quad, raster: GrayscaleRaster): Crop {
  const [a, b, c, d] = quad;
  return {
    points: [
      normalize(a, raster),
      normalize(b, raster),
      normalize(c, raster),
      normalize(d, raster),
    ],
  };
}

function normalize(corner: Point, raster: GrayscaleRaster): [number, number] {
  return [clamp01(corner.x / raster.width), clamp01(corner.y / raster.height)];
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function at(raster: GrayscaleRaster, x: number, y: number): number {
  return raster.data[y * raster.width + x] ?? 0;
}
