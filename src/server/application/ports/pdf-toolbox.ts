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

// What a canonical PDF says about itself once it is assembled (docs/05 §5.5 step 1): the title
// somebody reads it under, and the date the paper carries — or, failing that, the day this instance
// first saw it.
export type PdfMetadata = {
  title: string;
  date: Date | null;
};

// Every operation on a binary format is delegated to the sibling Stirling-PDF container (ADR-012):
// LibreOffice and tesseract inside our own image would add gigabytes to it. Results come back as
// buffers — page-sized artifacts, immediately handed to FileStorage.
export abstract class PdfToolbox {
  // Which host the work goes to. Recorded on every step that uses it, so a failure in the log can be
  // followed into the container that produced it (docs/03 §3.3.18).
  abstract readonly endpoint: string;

  // Anything with a printed form — DOCX/XLSX/PPTX/ODT/…, plain text, Markdown — into the one page
  // shape everything else in the pipeline reads (docs/05 §5.5 step 1). Not just office formats:
  // a document is a PDF whatever it arrived as, so text goes through here too.
  abstract toPdf(source: NamedBinary): Promise<Buffer>;

  // First page of a PDF as a JPEG — the raw material for preview.jpg and thumb.jpg (step 2).
  abstract pdfFirstPageJpg(source: BinarySource, options?: FirstPageOptions): Promise<Buffer>;

  // Adds a text layer to a scanned PDF (step 3), with tesseract language codes such as ['rus','eng'].
  abstract ocrPdf(source: BinarySource, languages: readonly string[]): Promise<Buffer>;

  // One page per image, in the order given (docs/05 §5.5 step 1): this is how a photographed page
  // becomes a page of the canonical PDF.
  abstract imagesToPdf(images: readonly NamedBinary[]): Promise<Buffer>;

  // The parts of a document, in position order, into one PDF (docs/05 §5.5 step 1). A single-part
  // document never gets here — its part already is the canonical.
  abstract mergePdfs(parts: readonly BinarySource[]): Promise<Buffer>;

  // The document's title and date written into the PDF's own metadata (docs/05 §5.5 step 1). The
  // caller treats a failure as harmless — a PDF with the wrong /Title is still the document — but
  // this port says what happened rather than swallowing it here.
  abstract stampMetadata(source: BinarySource, metadata: PdfMetadata): Promise<Buffer>;

  abstract pdfPageCount(source: BinarySource): Promise<number>;

  // The PDF's own text as Markdown (step 3). One engine parses PDFs in this product, and it is this
  // one: the converter recovers paragraphs and headings, which is the difference between a readable
  // document and one long line (docs/05 §5.5).
  abstract pdfToMarkdown(source: BinarySource): Promise<string>;
}
