import type { Crop } from '../../../shared/contracts/documents';
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

  // The bounding box of what is actually on the image — the uniform border a scanner leaves around
  // a page, trimmed away — expressed as a quadrilateral, because that is what a crop is
  // (docs/03 §3.3.16). This is the fallback the corner detector answers with when it finds no page
  // (docs/05 §5.6).
  abstract contentBox(source: BinarySource): Promise<Crop>;

  // The stored quadrilateral applied as a perspective transform: a page photographed from the side
  // comes out flat and rectangular, at a size taken from the quad's own edges (docs/05 §5.6). The
  // result is a JPEG, ready to become one page of the canonical PDF.
  abstract applyCrop(source: BinarySource, crop: Crop): Promise<Buffer>;

  // The image as grayscale pixels, downscaled so its longest side is at most `maxDim` — what the
  // edge detector reads (docs/05 §5.6). Downscaled because detection wants shapes rather than
  // detail, and a full-resolution photograph is a hundred times the work for the same four corners.
  abstract grayscaleRaster(source: BinarySource, maxDim: number): Promise<GrayscaleRaster>;
}
