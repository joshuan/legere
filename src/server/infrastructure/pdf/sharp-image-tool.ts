import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import type { Crop } from '../../../shared/contracts/documents';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import { ImageTool, type JpegPreviewOptions } from '../../application/ports/image-tool';
import { planCrop, rectangleToCrop, warpPerspective } from '../../domain/entities/crop-geometry';
import type { GrayscaleRaster } from '../../domain/entities/page-detection';

const DEFAULT_QUALITY = 80;

// 🔒 The most pixels this instance will decode out of one image. sharp's own default (~268 Mpx) is a
// ceiling on what libvips can address, not a budget anybody can afford: a 16383×16383 single-colour
// PNG is a few hundred KB — far under `UPLOAD_MAX_BYTES` — and decodes to ~805 MB of raw RGB, with
// the warp below allocating an output of comparable size. Nest, Next and the queue workers share one
// process (docs/02 ADR-002), so that OOM is the HTTP surface as well, and the queue's five retries
// detonate it five times (docs/05 §5.4).
//
// 80 Mpx: an A3 sheet scanned at 600 dpi is 69.7 Mpx and a 100-megapixel phone sensor is 100 Mpx
// after its own crop, so every scan a document archive actually meets fits, while the worst
// legitimate case peaks at ~240 MB raw plus a warp output of the same order. Past it the step fails
// with the message sharp gives — "Input image exceeds pixel limit" — which is recorded against the
// document like any other step failure, and the rest of the archive keeps processing.
const MAX_INPUT_PIXELS = 80_000_000;

// Options every pipeline in this file opens with. `sequentialRead` lets libvips work a scanline at a
// time instead of holding a decoded page, which is what makes a large-but-legitimate scan cheap.
const INPUT = { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true } as const;

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

@Injectable()
export class SharpImageTool extends ImageTool {
  async toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer> {
    return (
      sharp(await toBuffer(source), INPUT)
        // A photo taken sideways carries its rotation in EXIF only; without this the preview is
        // rotated while every viewer shows the original upright.
        .rotate()
        // `inside` keeps the aspect ratio and bounds the longest side; `withoutEnlargement` leaves a
        // small image at its own size rather than blowing it up into a blurry one.
        .resize({
          width: options.maxDim,
          height: options.maxDim,
          fit: 'inside',
          withoutEnlargement: true,
        })
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
    const upright = await sharp(await toBuffer(source), INPUT)
      .rotate()
      .toBuffer();
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
    const decoded = await sharp(await toBuffer(source), INPUT)
      .rotate()
      // Transparency has no meaning on a page of a PDF, and raw pixels with an alpha channel would
      // carry it into the warp for nothing.
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const raster = {
      data: new Uint8Array(decoded.data),
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    };
    const warped = warpPerspective(
      raster,
      planCrop(crop, { width: raster.width, height: raster.height }),
    );

    return sharp(Buffer.from(warped.data), {
      ...INPUT,
      raw: { width: warped.width, height: warped.height, channels: channelsOf(warped.channels) },
    })
      .jpeg({ quality: CROP_QUALITY })
      .toBuffer();
  }

  async grayscaleRaster(source: BinarySource, maxDim: number): Promise<GrayscaleRaster> {
    const decoded = await sharp(await toBuffer(source), INPUT)
      .rotate()
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
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
}

// sharp types the channel count of a raw buffer as a fixed set; anything outside it never comes out
// of a decode, but the compiler has no way of knowing that.
function channelsOf(channels: number): 1 | 2 | 3 | 4 {
  if (channels === 1) return 1;
  if (channels === 2) return 2;
  if (channels === 4) return 4;
  return 3;
}
