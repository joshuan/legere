// Turning whatever a file holds into the Markdown that step 3 stores and Postgres indexes
// (docs/05 §5.5). Pure text work, kept out of the handler so the rules are testable on their own.

// Single-byte legacy encoding of the Cyrillic world; every byte maps to something, so decoding it
// never fails. It is the realistic second guess for a .txt that is not valid UTF-8.
const LEGACY_ENCODING = 'windows-1251';

// Bytes → text, without ever throwing: an undecodable file must still produce a document, even if
// some characters come out as replacements (docs/05 §5.5: "encoding normalization").
export function decodeText(bytes: Uint8Array): string {
  try {
    // Strict first: a file that really is UTF-8 must not be mangled by the legacy guess below.
    return normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    // Not UTF-8. Try the legacy encoding, and if this runtime was built without the tables for it,
    // fall back to lossy UTF-8 — replacement characters, never a crash.
    try {
      return normalizeText(new TextDecoder(LEGACY_ENCODING).decode(bytes));
    } catch {
      return normalizeText(new TextDecoder('utf-8').decode(bytes));
    }
  }
}

// A byte-order mark is invisible to a reader but not to a search index; CRLF and lone CR come from
// files written on other systems; and a NUL byte cannot be stored in a Postgres text column at all.
export function normalizeText(text: string): string {
  return (
    text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex -- a NUL byte is exactly what has to go.
      .replace(/\u0000/g, '')
      .trim()
  );
}

// What the converter returned, tidied but not flattened. Line breaks and blank lines are structure —
// paragraphs, list items, table rows — and collapsing them (which is what this used to do) turned
// every document into one unbroken line in the viewer. Only runs of three or more blank lines go,
// since those are page gaps rather than meaning.
export function tidyMarkdown(markdown: string): string {
  return normalizeText(markdown)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

// How much real text a PDF carries per page — the measure that decides whether a document is a scan
// (docs/05 §5.5: below PDF_TEXT_MIN_CHARS_PER_PAGE on average → OCR). The extractor returns the
// document whole, so the count is divided by the pages rather than measured page by page.
export function charsPerPage(markdown: string, pageCount: number): number {
  if (pageCount <= 0) return meaningfulChars(markdown);
  return meaningfulChars(markdown) / pageCount;
}

export function hasUsableTextLayer(
  markdown: string,
  pageCount: number,
  minCharsPerPage: number,
): boolean {
  return charsPerPage(markdown, pageCount) >= minCharsPerPage;
}

// Whitespace is what a thin PDF text layer is mostly made of — positioning artefacts, not content.
// Exported because "did this come back with less than we already had" is the same question, asked of
// a transcription rather than of a text layer (docs/05 §5.5 step 3).
export function meaningfulChars(page: string): number {
  return page.replace(/\s+/g, '').length;
}

// Extractors emit text run by run, so a page arrives full of stray spacing; paragraph breaks (blank
// lines) survive, everything else collapses to single spaces.
