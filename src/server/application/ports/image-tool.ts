import type { Crop, Rotation } from '../../../shared/contracts/documents';
import type { GrayscaleRaster } from '../../domain/entities/page-detection';
import type { BinarySource } from './binary-source';

export type JpegPreviewOptions = {
  // The longest side of the result, in pixels. Smaller images are never upscaled.
  maxDim: number;
  quality?: number;
};

// Light image work stays in-process (ADR-012 allows narrow Node libraries for operations that do not
// need Stirling): resizing a preview is not worth an HTTP round trip, and neither is a perspective
// transform over pixels this process already holds.
export abstract class ImageTool {
  abstract toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer>;

  // How big the picture is, in pixels. Read for one reason: the shape of a page is decided from the
  // shape of what it was made from, and a photograph of a sheet has to be told from a photograph of
  // a receipt before either becomes a page (docs/05 §5.5 step 1).
  abstract dimensions(source: BinarySource): Promise<{ width: number; height: number }>;

  // The bounding box of what is actually on the image — the uniform border a scanner leaves around
  // a page, trimmed away — expressed as a quadrilateral, because that is what a crop is
  // (docs/03 §3.3.16). This is the fallback the corner detector answers with when it finds no page
  // (docs/05 §5.6).
  abstract contentBox(source: BinarySource): Promise<Crop>;

  // The stored quadrilateral applied as a perspective transform: a page photographed from the side
  // comes out flat and rectangular, at a size taken from the quad's own edges (docs/05 §5.6). The
  // result is a JPEG, ready to become one page of the canonical PDF.
  abstract applyCrop(source: BinarySource, crop: Crop): Promise<Buffer>;

  // Which way up the paper lay, applied: the mirror first and then the quarter turns clockwise
  // (docs/03 §3.3.16). Run *after* the crop, so the stored quadrilateral keeps meaning what it meant
  // in the pixels that arrived (docs/05 §5.5 step 1). The result is a JPEG, like a cropped page.
  //
  // 🔒 On top of EXIF, never instead of it: a photograph taken sideways is stood up the way every
  // viewer stands it up, and a person's turn is a turn on top of that.
  abstract applyRotation(source: BinarySource, rotation: Rotation): Promise<Buffer>;

  // The two things a camera does to a page and a scanner does not: it lights it from one side and
  // holds it at an angle (docs/05 §5.5 step 1). Both are undone here, before the picture becomes a
  // page, because both are why a single threshold over the whole sheet reads the lit half and loses
  // the shaded one. The result is a JPEG, like a cropped page.
  //
  // `null` means the picture needed neither: a scan that is already flat and straight keeps its own
  // bytes rather than being re-encoded into a slightly worse copy of itself, and the caller sends
  // the original on. Deciding that here rather than at the call site is deliberate — what "already
  // flat" means is measured off the same pixels the correction would have used.
  abstract correctPage(source: BinarySource): Promise<Buffer | null>;

  // The image as grayscale pixels, downscaled so its longest side is at most `maxDim` — what the
  // edge detector reads (docs/05 §5.6). Downscaled because detection wants shapes rather than
  // detail, and a full-resolution photograph is a hundred times the work for the same four corners.
  abstract grayscaleRaster(source: BinarySource, maxDim: number): Promise<GrayscaleRaster>;
}
