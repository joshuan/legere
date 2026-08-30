import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import sharp from 'sharp';
import type { Crop, Rotation } from '../../../shared/contracts/documents';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import { ImageTool, type JpegPreviewOptions } from '../../application/ports/image-tool';
import { planCrop, rectangleToCrop, warpPerspective } from '../../domain/entities/crop-geometry';
import type { GrayscaleRaster } from '../../domain/entities/page-detection';

const DEFAULT_QUALITY = 80;

// 🔒 The most pixels this instance will *work on*: the raster every pipeline below is brought under
// before anything else touches it. sharp's own default (~268 Mpx) is a ceiling on what libvips can
// address, not a budget anybody can afford: a 16383×16383 single-colour PNG is a few hundred KB —
// far under `UPLOAD_MAX_BYTES` — and decodes to ~805 MB of raw RGB, with the warp below allocating
// an output of comparable size. Nest, Next and the queue workers share one process (docs/02
// ADR-002), so that OOM is the HTTP surface as well, and the queue's five retries detonate it five
// times (docs/05 §5.4).
//
// 80 Mpx: an A3 sheet scanned at 600 dpi is 69.7 Mpx, so every scan a document archive actually
// meets fits, while the worst legitimate case peaks at ~240 MB raw plus a warp output of the same
// order.
const MAX_INPUT_PIXELS = 80_000_000;

// 🔒 And the most this will *read*, on the way down to that bound. A picture past the bound is not
// refused — a 100-megapixel photograph is a page like any other, and refusing it is how the simplest
// step in the pipeline became the one that could not render a large scan (docs/05 §5.4a). Its size
// is read off its header, which decodes no pixels, and the decode is then opened with a `resize`
// that brings the raster under the working bound before the rest of the pipeline sees it. libvips
// streams that shrink a scanline at a time, so what is held is the raster being written rather than
// the one being read: measured here, a 268 Mpx PNG costs 87 MB of resident memory on its way to a
// preview and 557 MB on its way to a full-bound raster, against 46 MB and 506 MB for a picture
// already at the bound — the difference is the loader's own scanlines, and the bound above still
// decides the rest.
//
// The ceiling is sharp's own default, 16383² — what libvips can address at all. Past it there is no
// way down that is worth trying, and the step fails naming the size it was handed rather than
// repeating the library's words.
const MAX_DECODE_PIXELS = 268_402_689;

// Options every pipeline in this file opens with. `sequentialRead` lets libvips work a scanline at a
// time instead of holding a decoded page, which is what makes a large-but-legitimate scan cheap.
const INPUT = { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true } as const;

// The same, for a picture on its way down to the working bound: the decode may read what libvips can
// address because a `resize` under it is what the pipeline actually holds.
const OVERSIZE_INPUT = { limitInputPixels: MAX_DECODE_PIXELS, sequentialRead: true } as const;

// 🔒 Process-wide, set once at load. The libvips operation cache holds decoded images between calls
// for a hit rate of approximately zero here — every document is a different image — so it is pure
// resident memory; and libvips would otherwise start a thread pool per pipeline, which in a process
// that is also answering HTTP means image work can starve the API (docs/05 §5.4). Concurrency of the
// pipeline itself is `unitConcurrency`, and that is where it belongs.
sharp.cache(false);
sharp.concurrency(1);

// A cropped page becomes a page of the canonical PDF and is then read by OCR, so it is kept better
// than a preview: the difference between 80 and 92 is invisible to a person and audible to tesseract.
const CROP_QUALITY = 92;

// How aggressively `trim` decides a pixel is background. A scanner's white is never quite white, and
// a threshold too low leaves a grey frame around every page (docs/05 §5.6).
const TRIM_THRESHOLD = 10;

// --- What a camera does to a page, undone (docs/05 §5.5 step 1) ------------------------------
//
// The lighting is levelled by dividing the page by its own paper: every pixel is multiplied until
// the paper *around* it reads white, so the shaded half of the sheet and the lit half arrive at the
// same brightness and one threshold can serve both. The numbers below were measured on the
// photograph this exists for — a lab report whose results table the recognizer was losing.

// The lighting of a sheet is a slow thing: a shadow across it, the fall-off of a lamp, the vignette
// of a lens. None of that needs full resolution, so it is read off a thumbnail this many pixels on
// the longest side. A full-resolution blur would cost a second per page and answer the same field.
const FIELD_DIM = 128;

// The field has to be the *paper*, not the ink on it, so each cell takes the brightest pixel in a
// window this many cells wide. Ink is dark and local; paper is bright and everywhere. At 128 cells
// a radius of one is ~70 pixels of a 3000-pixel photograph — wider than a stroke of bold text, so
// text cannot pull the paper level down and be lightened by its own shadow.
const PAPER_WINDOW = 1;

// A maximum leaves steps where the window crossed a dark region; averaging over this many cells
// turns them back into the smooth gradient a lamp actually makes.
const FIELD_SMOOTH = 2;

// 🔒 The deepest shadow this will lift. The gain is applied to every pixel, so an unbounded one
// turns a photograph of a dark object into a white rectangle; four times is two stops, past what a
// desk lamp does to a sheet of paper and short of inventing a page that was never there. Measured:
// between four and unbounded the recognised text of the reference photograph moves by 1%.
const MAX_GAIN = 4;

// 🔒 How uneven the lighting has to be before any of this is worth doing, as the drop from the
// brightest paper on the page to the darkest, over the brightest. Measured on real pictures: a
// scanner's own scan spreads 0.01, a page this correction has already levelled 0.06, and a
// photograph lit from one side 0.28 to 0.60. The threshold sits in the middle of that gap, which is
// what makes "already flat comes out unchanged" a fact about the picture rather than a hope.
const MIN_SPREAD = 0.1;

// 🔒 And the assumption the whole correction rests on: dark ink, light paper, ink in the minority.
// The median of the picture against the paper level says so — 0.77 to 0.84 for every photograph of
// a sheet measured, 0.16 for a dark-theme screenshot, which is exactly the picture that must not be
// "levelled" into a blank white page.
const MIN_PAPER_SHARE = 0.5;

// What counts as ink when the skew is being looked for: a quarter darker than the paper beside it,
// and by at least a few levels so that paper noise is not read as text. Measured against the field
// rather than against a fixed grey, so it means the same thing on a page this has levelled and on
// one it has left alone.
const INK_RATIO = 0.75;
const INK_MARGIN = 8;

// The skew is looked for on a raster this many pixels on the longest side. What is being found is
// the direction of the lines of text, and a line of text is still a line at 900 pixels across —
// looking for it at full resolution would be ten times the arithmetic for the same angle.
const DESKEW_DIM = 900;

// How far a page may be turned and still be a page held crookedly rather than a picture taken
// sideways — a quarter turn is EXIF's business, not this one.
const DESKEW_LIMIT_DEG = 8;

// And how far it has to be turned before turning it back is worth a resample. Below a degree the
// rotation costs more in blurred glyphs than the straightening returns: measured on the reference
// photograph, which sits at 0.65°, deskewing it *lost* text, while the same page at 3° gained a
// third of its table back. The recognizer straightens each line of text on its own anyway; what it
// cannot do is straighten a table.
const DESKEW_MIN_DEG = 1;
const DESKEW_COARSE_STEP = 0.5;
const DESKEW_FINE_STEP = 0.05;

// A projection profile needs lines to project. Below the first share the page is blank and there is
// nothing to align; above the second it is not a page of text at all, and whatever the search locked
// onto was not a line of it.
const MIN_INK_SHARE = 0.002;
const MAX_INK_SHARE = 0.5;

@Injectable()
export class SharpImageTool extends ImageTool {
  constructor(@InjectPinoLogger(SharpImageTool.name) private readonly logger: PinoLogger) {
    super();
  }

  async dimensions(source: BinarySource): Promise<{ width: number; height: number }> {
    const { width, height, quarterTurned } = await measured(await toBuffer(source));

    // 🔒 As it will be *shown*, not as it is stored. A photograph taken sideways carries its
    // rotation in EXIF, and `metadata` reports the stored size: orientations 5 through 8 are the
    // quarter turns, and for those the stored width is the displayed height. Read the wrong way
    // round, a portrait page would be laid out landscape — and every viewer would disagree with us
    // about which way up the document is.
    return quarterTurned ? { width: height, height: width } : { width, height };
  }

  async toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer> {
    // The longest side is the caller's own, since a preview is under the working bound whatever the
    // picture was: one `resize` does both, because sharp keeps only the last.
    const image = await this.opened(source, options.maxDim);
    return (
      image
        // A photo taken sideways carries its rotation in EXIF only; without this the preview is
        // rotated while every viewer shows the original upright.
        .rotate()
        // Flatten onto white: a transparent PNG would otherwise get a black background in JPEG.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: options.quality ?? DEFAULT_QUALITY })
        .toBuffer()
    );
  }

  // `trim` answers with the trimmed image and how far it moved; what a crop needs is where the
  // content was, so the offsets are turned back into a quadrilateral over the original
  // (docs/05 §5.6). An image that trims to nothing — a blank page — keeps its whole frame.
  async contentBox(source: BinarySource): Promise<Crop> {
    // Whatever comes back is under the working bound, so the two opens below are the plain ones —
    // and the answer is a quadrilateral in shares of the frame, which a downscale does not move.
    const image = await this.opened(source);
    const upright = await image.rotate().toBuffer();
    const original = await sharp(upright, INPUT).metadata();
    const width = original.width ?? 0;
    const height = original.height ?? 0;
    if (width < 1 || height < 1) {
      throw new Error('The image has no readable dimensions');
    }

    try {
      const trimmed = await sharp(upright, INPUT)
        .trim({ threshold: TRIM_THRESHOLD })
        .toBuffer({ resolveWithObject: true });
      // The offsets say where the trimmed image has to be put back, so they are negative; the
      // rectangle wants the position it was taken from.
      return rectangleToCrop(
        {
          left: Math.abs(trimmed.info.trimOffsetLeft ?? 0),
          top: Math.abs(trimmed.info.trimOffsetTop ?? 0),
          width: trimmed.info.width,
          height: trimmed.info.height,
        },
        { width, height },
      );
    } catch {
      // sharp refuses to trim an image that is uniform all over — there would be nothing left. That
      // is not a failure of the request: the honest content box of a blank page is the page.
      return rectangleToCrop({ left: 0, top: 0, width, height }, { width, height });
    }
  }

  // The quadrilateral as a perspective transform over raw pixels: sharp decodes and encodes, the
  // geometry is the domain's (docs/05 §5.6).
  async applyCrop(source: BinarySource, crop: Crop): Promise<Buffer> {
    // 🔒 The decode is brought under `MAX_INPUT_PIXELS` like every other pipeline in this file, and
    // since `planCrop` will not plan an output larger than its input, that one number now bounds
    // both rasters a crop holds rather than only the first (docs/05 §5.4a).
    const image = await this.opened(source);
    const decoded = await image
      .rotate()
      // Transparency has no meaning on a page of a PDF, and raw pixels with an alpha channel would
      // carry it into the warp for nothing.
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 🔒 The decoded buffer itself, not a copy of it. A Buffer *is* a Uint8Array, the warp only
    // reads its source, and at the top of the pixel budget the copy this used to make was another
    // 240 MB held for the length of the resample — in the process that is also answering HTTP
    // (ADR-002, docs/05 §5.4a).
    const raster = {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    };
    const warped = warpPerspective(
      raster,
      planCrop(crop, { width: raster.width, height: raster.height }),
    );

    // And the same on the way out: a view over the bytes the warp just wrote rather than a second
    // copy of them, the way `blobOf` re-views a scan instead of holding it twice.
    return sharp(Buffer.from(warped.data.buffer, warped.data.byteOffset, warped.data.byteLength), {
      ...INPUT,
      raw: { width: warped.width, height: warped.height, channels: channelsOf(warped.channels) },
    })
      .jpeg({ quality: CROP_QUALITY })
      .toBuffer();
  }

  // Which way up the paper lay (docs/03 §3.3.16): the mirror first, left to right, then the quarter
  // turns clockwise. `.rotate()` with no argument comes first and is a different thing entirely — it
  // is EXIF, what every viewer already does to the file — so the stored turn is applied to the
  // picture as anybody would see it rather than to whichever way the sensor wrote the rows.
  async applyRotation(source: BinarySource, rotation: Rotation): Promise<Buffer> {
    const upright = (await this.opened(source)).rotate();
    const mirrored = rotation.mirrored ? upright.flop() : upright;
    const turned =
      rotation.quarterTurns === 0
        ? mirrored
        : // sharp turns clockwise for a positive angle, which is the direction the contract counts in.
          mirrored.rotate(rotation.quarterTurns * 90);
    // Flattened for the reason the crop flattens: a page of a PDF has no transparency, and a
    // transparent PNG would otherwise turn black in JPEG.
    return turned.flatten({ background: '#ffffff' }).jpeg({ quality: CROP_QUALITY }).toBuffer();
  }

  // Lighting levelled, skew taken out, and nothing done to a page that needs neither
  // (docs/05 §5.5 step 1). Each half is decided on its own: a photograph of a straight page is
  // levelled and not turned, a crooked scan is turned and not levelled, and a scan that is both
  // flat and straight comes back as `null` — its own bytes, unre-encoded.
  async correctPage(source: BinarySource): Promise<Buffer | null> {
    const image = await this.opened(source);
    const decoded = await image
      .rotate()
      // Transparency has no meaning on a page of a PDF, and everything below reads brightness as
      // "how much paper is here": sRGB says that in the same numbers for a photograph, a greyscale
      // scan and a CMYK export, which raw channels would not.
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = decoded.info.width;
    const height = decoded.info.height;
    const channels = decoded.info.channels;
    if (width < 1 || height < 1) return null;

    const grey = luminanceOf(decoded.data, width * height, channels);
    const field = await illuminationFieldOf(grey, width, height);

    // Two questions, both answered off the field: is the lighting uneven enough to be worth
    // levelling, and is this a sheet of paper at all.
    const paperShare = field.paper === 0 ? 0 : medianOf(field.thumbnail) / field.paper;
    const uneven = field.spread >= MIN_SPREAD && paperShare >= MIN_PAPER_SHARE;

    const pixels = uneven
      ? await levelled(decoded.data, width, height, channels, field)
      : decoded.data;

    // The skew is looked for on the page as it was photographed, whether or not the lighting was
    // levelled: what makes a pixel ink is that it is darker than the paper beside it, and the field
    // says where the paper is either way.
    const angle = await skewOf(grey, width, height, field);

    if (!uneven && angle === 0) return null;

    const corrected = sharp(pixels, {
      ...INPUT,
      raw: { width, height, channels: channelsOf(channels) },
    });
    // sharp turns clockwise for a positive angle, and so does the shear that lines the text up.
    return (angle === 0 ? corrected : corrected.rotate(angle, { background: '#ffffff' }))
      .jpeg({ quality: CROP_QUALITY })
      .toBuffer();
  }

  async grayscaleRaster(source: BinarySource, maxDim: number): Promise<GrayscaleRaster> {
    const image = await this.opened(source, maxDim);
    const decoded = await image
      .rotate()
      .flatten({ background: '#ffffff' })
      .greyscale()
      // One byte per pixel is what the detector reads; anything else would have to be strided over.
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      data: new Uint8Array(decoded.data),
      width: decoded.info.width,
      height: decoded.info.height,
    };
  }

  // 🔒 What every pipeline in this file opens with: the picture, at a size this instance can work on
  // (docs/05 §5.4a). A raster already under the working bound is opened exactly as this file has
  // always opened one. One above it is opened at the decode ceiling with a `resize` that brings it
  // under the bound before anything downstream touches a pixel — the shrink libvips streams rather
  // than the decode nobody can afford.
  //
  // `maxDim` is for the two callers that resize anyway: a preview and the detector's raster are far
  // under the bound whatever the picture was, so the smaller of the two sides is asked for and the
  // pipeline carries one `resize`, because sharp keeps only the last.
  private async opened(source: BinarySource, maxDim: number | null = null): Promise<sharp.Sharp> {
    const bytes = await toBuffer(source);
    const { width, height, pixels } = await measured(bytes);
    const fitSide = fitSideOf(width, height);

    if (fitSide !== null) {
      // A page that arrived at less than its own resolution is a fact about the archive, not an
      // implementation detail: the step says so where every other outcome of it is said.
      this.logger.info(
        { width, height, pixels, side: fitSide, budget: MAX_INPUT_PIXELS },
        'An image past the pixel budget was opened smaller rather than refused',
      );
    }

    const side = smallerOf(fitSide, maxDim);
    if (side === null) return sharp(bytes, INPUT);
    return sharp(bytes, fitSide === null ? INPUT : OVERSIZE_INPUT).resize({
      // `inside` keeps the aspect ratio and bounds the longest side; `withoutEnlargement` leaves a
      // small image at its own size rather than blowing it up into a blurry one.
      width: side,
      height: side,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
}

// How large the picture is, off its header. 🔒 `metadata` parses the header and decodes no pixels —
// a few hundred bytes whatever the picture is — so it is the one read that may be made with no limit
// at all, and it is what turns the limit from a refusal into a decision. What it decides is below.
async function measured(
  bytes: Buffer,
): Promise<{ width: number; height: number; pixels: number; quarterTurned: boolean }> {
  const {
    width = 0,
    height = 0,
    orientation,
  } = await sharp(bytes, { limitInputPixels: false }).metadata();
  const pixels = width * height;

  // Past what libvips can address there is no shrink to stream it through, so the step fails here —
  // naming the picture it was handed, which is something an operator can act on, rather than
  // repeating "Input image exceeds pixel limit" at somebody who never chose the limit.
  if (pixels > MAX_DECODE_PIXELS) {
    throw new Error(
      `The image is ${width}×${height} (${megapixels(pixels)} Mpx), past the ` +
        `${megapixels(MAX_DECODE_PIXELS)} Mpx this instance can open`,
    );
  }

  return {
    width,
    height,
    pixels,
    quarterTurned: orientation !== undefined && orientation >= 5 && orientation <= 8,
  };
}

// The longest side a picture may be worked on at, or `null` when it is already small enough to be
// left alone. At exactly `√(bound · long / short)` the raster is the bound; one pixel comes off it
// because `fit: 'inside'` rounds the other side to a whole pixel, and a bound a rounding can cross
// is not a bound.
function fitSideOf(width: number, height: number): number | null {
  if (width * height <= MAX_INPUT_PIXELS) return null;
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  return Math.max(1, Math.floor(Math.sqrt((MAX_INPUT_PIXELS * longest) / shortest)) - 1);
}

function smallerOf(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function megapixels(pixels: number): string {
  return (pixels / 1_000_000).toFixed(1);
}

// sharp types the channel count of a raw buffer as a fixed set; anything outside it never comes out
// of a decode, but the compiler has no way of knowing that.
function channelsOf(channels: number): 1 | 2 | 3 | 4 {
  if (channels === 1) return 1;
  if (channels === 2) return 2;
  if (channels === 4) return 4;
  return 3;
}

// --- the page's own lighting, and the angle it was held at -----------------------------------

// How bright each pixel is, one byte apiece. Rec. 601 weights: the correction is about paper and
// ink, and how light a colour looks is what tells the two apart.
function luminanceOf(data: Buffer, pixels: number, channels: number): Uint8Array {
  const grey = new Uint8Array(pixels);
  for (let index = 0, offset = 0; index < pixels; index += 1, offset += channels) {
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? red;
    const blue = data[offset + 2] ?? red;
    grey[index] = (red * 77 + green * 151 + blue * 28) >> 8;
  }
  return grey;
}

// Where the paper is and how brightly it is lit, cell by cell — the thing a photograph has and a
// scan does not.
type IlluminationField = {
  data: Uint8Array;
  width: number;
  height: number;
  // The page as it was read, before the paper was picked out of it. Kept because "is this a sheet
  // of paper at all" is a question about the picture rather than about its lighting.
  thumbnail: Uint8Array;
  // The brightest paper on the page, and how far the darkest falls below it as a share of it.
  paper: number;
  spread: number;
};

async function illuminationFieldOf(
  grey: Uint8Array,
  width: number,
  height: number,
): Promise<IlluminationField> {
  const scale = FIELD_DIM / Math.max(width, height);
  const fieldWidth = Math.max(8, Math.min(width, Math.round(width * scale)));
  const fieldHeight = Math.max(8, Math.min(height, Math.round(height * scale)));

  const thumbnail = await resizedGrey(grey, { width, height }, fieldWidth, fieldHeight);
  const data = smoothed(
    brightest(thumbnail, fieldWidth, fieldHeight, PAPER_WINDOW),
    fieldWidth,
    fieldHeight,
    FIELD_SMOOTH,
  );

  const paper = percentileOf(data, 0.95);
  const darkest = percentileOf(data, 0.05);
  return {
    data,
    width: fieldWidth,
    height: fieldHeight,
    thumbnail,
    paper,
    spread: paper === 0 ? 0 : (paper - darkest) / paper,
  };
}

// Every pixel multiplied until the paper around it reads white. The gain is never below one — this
// lifts a shadow, it does not deepen one — and never above MAX_GAIN, which is what keeps a dark
// picture from being brightened into a blank one.
async function levelled(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  field: IlluminationField,
): Promise<Buffer> {
  const paper = await resizedGrey(
    field.data,
    { width: field.width, height: field.height },
    width,
    height,
  );

  const out = Buffer.allocUnsafe(width * height * channels);
  for (let index = 0, offset = 0; index < width * height; index += 1, offset += channels) {
    const gain = Math.min(255 / Math.max(1, paper[index] ?? 255), MAX_GAIN);
    for (let channel = 0; channel < channels; channel += 1) {
      const value = (data[offset + channel] ?? 0) * gain;
      out[offset + channel] = value > 255 ? 255 : value;
    }
  }
  return out;
}

// How far the page is turned, in degrees, clockwise-positive — or zero when turning it back is not
// worth the resample (docs/05 §5.5 step 1). Found by the oldest method there is: shear the ink by a
// candidate angle and add up each row. Lines of text that agree on a direction pile into some rows
// and leave the gaps between them empty, so the shear whose profile has the sharpest steps is the
// one that lines the text up.
async function skewOf(
  grey: Uint8Array,
  width: number,
  height: number,
  field: IlluminationField,
): Promise<number> {
  const scale = Math.min(1, DESKEW_DIM / Math.max(width, height));
  const deskewWidth = Math.max(8, Math.round(width * scale));
  const deskewHeight = Math.max(8, Math.round(height * scale));

  const [page, paper] = await Promise.all([
    resizedGrey(grey, { width, height }, deskewWidth, deskewHeight),
    resizedGrey(
      field.data,
      { width: field.width, height: field.height },
      deskewWidth,
      deskewHeight,
    ),
  ]);

  const ink = new Uint8Array(deskewWidth * deskewHeight);
  let inked = 0;
  for (let index = 0; index < ink.length; index += 1) {
    const dark = (page[index] ?? 255) < (paper[index] ?? 255) * INK_RATIO - INK_MARGIN;
    ink[index] = dark ? 1 : 0;
    if (dark) inked += 1;
  }

  const share = inked / ink.length;
  if (share < MIN_INK_SHARE || share > MAX_INK_SHARE) return 0;

  // Coarse first, then finely around the winner: a full sweep at a twentieth of a degree would be
  // ten times the work for the same answer.
  const coarse = bestShear(
    ink,
    deskewWidth,
    deskewHeight,
    -DESKEW_LIMIT_DEG,
    DESKEW_LIMIT_DEG,
    DESKEW_COARSE_STEP,
  );
  const fine = bestShear(
    ink,
    deskewWidth,
    deskewHeight,
    coarse - DESKEW_COARSE_STEP,
    coarse + DESKEW_COARSE_STEP,
    DESKEW_FINE_STEP,
  );
  return Math.abs(fine) < DESKEW_MIN_DEG ? 0 : fine;
}

function bestShear(
  ink: Uint8Array,
  width: number,
  height: number,
  from: number,
  to: number,
  step: number,
): number {
  let bestAngle = 0;
  let bestScore = -1;
  // Counted in whole steps rather than added up: a degree reached by accumulating twentieths is not
  // quite a degree.
  const steps = Math.round((to - from) / step);
  for (let index = 0; index <= steps; index += 1) {
    const angle = from + index * step;
    const score = profileScoreOf(ink, width, height, angle);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

function profileScoreOf(ink: Uint8Array, width: number, height: number, degrees: number): number {
  const tangent = Math.tan((degrees * Math.PI) / 180);
  const span = Math.abs(Math.round(tangent * width));
  const rows = new Float64Array(height + span + 2);
  // A negative shear moves the top rows off the front of the array; the whole profile is offset
  // rather than clipped, because a row lost is a step invented.
  const offset = tangent < 0 ? span + 1 : 0;

  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      if (ink[base + x] === 1) {
        const row = offset + y + Math.round(tangent * x);
        rows[row] = (rows[row] ?? 0) + 1;
      }
    }
  }

  // The sharpness of the profile, not its size: it is the step between neighbouring rows that says
  // "a line of text ends here", and the sum of squares is largest when those steps are cliffs.
  let score = 0;
  for (let row = 1; row < rows.length; row += 1) {
    const step = (rows[row] ?? 0) - (rows[row - 1] ?? 0);
    score += step * step;
  }
  return score;
}

// The brightest pixel in a window this many cells wide — the paper under the ink.
function brightest(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let peak = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const column = x + dx;
          if (column < 0 || column >= width) continue;
          const value = source[row * width + column] ?? 0;
          if (value > peak) peak = value;
        }
      }
      out[y * width + x] = peak;
    }
  }
  return out;
}

// A box blur, in two passes because a square average is two lines of one — the maximum above leaves
// steps where its window crossed a dark region, and a lamp does not make steps.
function smoothed(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let taken = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const column = x + dx;
        if (column < 0 || column >= width) continue;
        sum += source[y * width + column] ?? 0;
        taken += 1;
      }
      horizontal[y * width + x] = sum / Math.max(1, taken);
    }
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let taken = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        sum += horizontal[row * width + x] ?? 0;
        taken += 1;
      }
      out[y * width + x] = Math.round(sum / Math.max(1, taken));
    }
  }
  return out;
}

// One byte per pixel in and out. `fill` rather than `inside`: these rasters are read pixel against
// pixel over the same rectangle, so the shape is already right and fitting it again would shift
// everything by a row.
async function resizedGrey(
  source: Uint8Array,
  from: { width: number; height: number },
  width: number,
  height: number,
): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(Buffer.from(source), {
      ...INPUT,
      raw: { width: from.width, height: from.height, channels: 1 },
    })
      .resize(width, height, { fit: 'fill' })
      // Without this sharp answers three channels for a one-channel raster.
      .toColourspace('b-w')
      .raw()
      .toBuffer(),
  );
}

function percentileOf(values: Uint8Array, share: number): number {
  const sorted = Uint8Array.from(values).sort();
  return sorted[Math.round((sorted.length - 1) * share)] ?? 0;
}

function medianOf(values: Uint8Array): number {
  return percentileOf(values, 0.5);
}
