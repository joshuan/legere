// The tunable parts of the pipeline (docs/12 §12.4), passed to the handlers as plain values: the
// application layer stays framework-free and never reads configuration itself.
export type ProcessingSettings = {
  previewMaxDim: number;
  thumbMaxDim: number;
  // tesseract language codes, in the order OCR should try them.
  ocrLanguages: readonly string[];
  // Below this many characters per page, a PDF's text layer is not worth trusting (docs/05 §5.9).
  pdfTextMinCharsPerPage: number;
  // Chunking for embedding: the size to aim for and how much of each chunk repeats in the next.
  chunkTargetChars: number;
  chunkOverlapChars: number;
  // How much of a document's text the analyst is shown. `0` is the whole of it, which is the
  // default: a cap put a model in the position of naming a contract from its letterhead
  // (docs/05 §5.5 step 4).
  analystExcerptChars: number;
  // How many of its pages travel with that text as pictures. Past this a document is a book rather
  // than a paper, and its text carries it; the pages themselves are what a scan has instead of text
  // when recognition found nothing.
  analystMaxPageImages: number;
  // The longest side of each of those pictures. A model reads a page, it does not print it.
  analystPageImageMaxDim: number;
};
