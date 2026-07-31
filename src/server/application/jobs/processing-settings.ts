// The tunable parts of the pipeline (docs/12 §12.4), passed to the handlers as plain values: the
// application layer stays framework-free and never reads configuration itself.
export type ProcessingSettings = {
  previewMaxDim: number;
  thumbMaxDim: number;
  // tesseract language codes, in the order OCR should try them.
  ocrLanguages: readonly string[];
  // Below this many characters per page, a PDF's text layer is not worth trusting (docs/05 §5.9).
  pdfTextMinCharsPerPage: number;
};
