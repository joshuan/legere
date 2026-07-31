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

// Page texts → one Markdown body. Pages are joined by a blank line and nothing else: a "Page 3"
// heading per page would be indexed as content and would surface in every search snippet.
export function markdownFromPages(pages: readonly string[]): string {
  return pages
    .map((page) => normalizeText(collapseWhitespace(page)))
    .filter((page) => page !== '')
    .join('\n\n');
}

// How much real text a PDF's text layer carries, per page — the measure that decides whether a
// document is a scan (docs/05 §5.9: below PDF_TEXT_MIN_CHARS_PER_PAGE on average → OCR).
export function charsPerPage(pages: readonly string[]): number {
  if (pages.length === 0) return 0;
  const total = pages.reduce((sum, page) => sum + meaningfulChars(page), 0);
  return total / pages.length;
}

export function hasUsableTextLayer(pages: readonly string[], minCharsPerPage: number): boolean {
  return charsPerPage(pages) >= minCharsPerPage;
}

// Whitespace is what a thin PDF text layer is mostly made of — positioning artefacts, not content.
function meaningfulChars(page: string): number {
  return page.replace(/\s+/g, '').length;
}

// Extractors emit text run by run, so a page arrives full of stray spacing; paragraph breaks (blank
// lines) survive, everything else collapses to single spaces.
function collapseWhitespace(page: string): string {
  return page
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}
