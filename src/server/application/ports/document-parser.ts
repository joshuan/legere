import type { BinarySource } from './binary-source';

export type ParseOptions = {
  // Tesseract language codes, in priority order, for the OCR pass. Empty means "no OCR": a PDF that
  // carries its own text is read, not recognised.
  ocrLanguages: readonly string[];
};

// Turning a document into Markdown — the one place in the product that reads layout (docs/05 §5.5).
// A dedicated port rather than another method on PdfToolbox: this is a different container doing a
// different job (layout and table models, not PDF surgery), and an instance may run without it.
export abstract class DocumentParser {
  // Empty when the parser is not configured; the pipeline then falls back to PdfToolbox.
  abstract readonly isConfigured: boolean;

  // Which host the work goes to (docs/03 §3.3.18); empty when unconfigured.
  abstract readonly endpoint: string;

  abstract toMarkdown(source: BinarySource, options: ParseOptions): Promise<string>;
}
