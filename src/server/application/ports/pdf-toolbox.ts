import type { BinarySource } from './binary-source';

export type NamedBinary = {
  body: BinarySource;
  // The converter picks its input format from the file name, so it travels with the bytes.
  fileName: string;
};

export type FirstPageOptions = {
  // Rendering resolution. Higher means a sharper preview and a slower, larger render; the caller
  // downscales the result to the configured preview dimensions afterwards.
  dpi?: number;
};

// Every operation on a binary format is delegated to the sibling Stirling-PDF container (ADR-012):
// LibreOffice and tesseract inside our own image would add gigabytes to it. Results come back as
// buffers — page-sized artifacts, immediately handed to FileStorage.
export abstract class PdfToolbox {
  // Which host the work goes to. Recorded on every step that uses it, so a failure in the log can be
  // followed into the container that produced it (docs/03 §3.3.18).
  abstract readonly endpoint: string;

  // Office formats (DOCX/XLSX/PPTX/ODT/…) → the canonical PDF of docs/05 §5.5 step 1.
  abstract officeToPdf(source: NamedBinary): Promise<Buffer>;

  // First page of a PDF as a JPEG — the raw material for preview.jpg and thumb.jpg (step 2).
  abstract pdfFirstPageJpg(source: BinarySource, options?: FirstPageOptions): Promise<Buffer>;

  // Adds a text layer to a scanned PDF (step 3), with tesseract language codes such as ['rus','eng'].
  abstract ocrPdf(source: BinarySource, languages: readonly string[]): Promise<Buffer>;

  // Scan-set merge (docs/05 §5.6): one page per image, in the order given.
  abstract imagesToPdf(images: readonly NamedBinary[]): Promise<Buffer>;

  abstract pdfPageCount(source: BinarySource): Promise<number>;

  // The PDF's own text as Markdown (step 3). One engine parses PDFs in this product, and it is this
  // one: the converter recovers paragraphs and headings, which is the difference between a readable
  // document and one long line (docs/05 §5.5).
  abstract pdfToMarkdown(source: BinarySource): Promise<string>;
}
