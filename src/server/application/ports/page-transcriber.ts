import type { PageImage } from './document-analyst';

// What one transcription cost, as the provider itself accounted for it (docs/03 §3.3.18).
export type TranscriptionUsage = { promptTokens?: number; completionTokens?: number };

export type Transcription = {
  // The document as Markdown, exactly as the model read it off the pages.
  markdown: string;
  usage: TranscriptionUsage;
};

// The recogniser of last resort (docs/05 §5.5 step 3): a vision model reading the pages themselves.
//
// It exists because the cheap path has a floor that no amount of tuning lifts. Measured on one real
// photograph of a lab report: 665 characters are legible on the page and 415 reach the database —
// and the missing quarter is the results table, which is the only reason that document exists. The
// same loss reproduces on the raw photograph with no page around it, and cropping to the table alone
// reads it correctly, so it is not the geometry and not the threshold: uneven light and bold text
// pressed against thin cell rules defeat a global binariser and the layout pass behind it. A model
// that looks at the page does not have that failure mode.
//
// A port of its own rather than another method on DocumentAnalyst, though both may speak to the same
// provider: analysing is answering questions *about* a document, transcribing is producing the
// document's text, and an instance may want a different model for each — or one and not the other.
export abstract class PageTranscriber {
  // Unconfigured is not a failure: the tesseract result stands, exactly as it does today
  // (docs/05 §5.5).
  abstract get isConfigured(): boolean;

  // Which host the work goes to (docs/03 §3.3.18); empty when unconfigured.
  abstract get endpoint(): string;

  // The pages of one document, in order, as one piece of Markdown. `languages` are the document's
  // own, so the model is told what it is looking at rather than guessing from the glyphs.
  abstract transcribe(
    pages: readonly PageImage[],
    languages: readonly string[],
  ): Promise<Transcription>;
}
