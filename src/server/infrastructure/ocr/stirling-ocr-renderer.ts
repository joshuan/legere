import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  OcrPageRenderer,
  OcrProviderError,
  type OcrImage,
} from '../../application/ports/page-ocr-provider';
import type { FileStorage } from '../../application/ports/file-storage';
import type { PdfToolbox } from '../../application/ports/pdf-toolbox';

export class StirlingOcrRenderer extends OcrPageRenderer {
  constructor(
    private readonly files: FileStorage,
    private readonly pdfs: PdfToolbox,
  ) {
    super();
  }
  async render(sourceKey: string, page: number): Promise<OcrImage> {
    for (const dpi of [300, 200, 150, 100, 72]) {
      const bytes = await this.pdfs.pdfPagePng(await this.files.getStream(sourceKey), {
        page,
        dpi,
      });
      const { width, height } = await sharp(bytes, { limitInputPixels: 200_000_000 }).metadata();
      if (width === undefined || height === undefined)
        throw new OcrProviderError('Rendered OCR page has no dimensions', false);
      if (width * height > 20_000_000 || bytes.length > 9_000_000) continue;
      return { bytes, width, height, dpi, hash: createHash('sha256').update(bytes).digest('hex') };
    }
    throw new OcrProviderError('This page exceeds OCR image limits even at 72 DPI', false);
  }
}
