import type { BinarySource } from './binary-source';

export type JpegPreviewOptions = {
  // The longest side of the result, in pixels. Smaller images are never upscaled.
  maxDim: number;
  quality?: number;
};

// Light image work stays in-process (ADR-012 allows narrow Node libraries for operations that do not
// need Stirling): resizing a preview is not worth an HTTP round trip.
export abstract class ImageTool {
  abstract toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer>;

  // Trims a uniform border — the scanner background around a photographed page (docs/05 §5.6).
  // `threshold` is how far a pixel may differ from the border colour and still count as border.
  abstract trim(source: BinarySource, threshold: number): Promise<Buffer>;
}
