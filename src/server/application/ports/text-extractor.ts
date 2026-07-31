import type { BinarySource } from './binary-source';

// Reading an existing text layer needs no external container (ADR-012), and the per-page split is
// what decides whether a PDF has meaningful text or has to go through OCR (docs/05 §5.5 step 3).
export abstract class TextExtractor {
  // One entry per page, in page order; a page without a text layer yields an empty string.
  abstract pdfTextByPage(source: BinarySource): Promise<string[]>;
}
