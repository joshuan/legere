// How a document travels through the pipeline is decided by its detected content type, not by its
// extension (docs/03 §3.3.10). Step 1 of docs/05 §5.5 branches on exactly these five cases.
export type DocumentFormat = 'PDF' | 'OFFICE' | 'IMAGE' | 'TEXT' | 'UNSUPPORTED';

const PDF_MIME = 'application/pdf';

// Everything LibreOffice converts inside Stirling (docs/05 §5.5 step 1: "DOCX/XLSX/PPTX/ODT/…").
const OFFICE_MIMES: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
  'application/epub+zip',
  'text/html',
]);

// Formats whose bytes are already readable text: no canonicalization, no preview, passed through to
// Markdown as they are (docs/05 §5.5).
const TEXT_MIMES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
]);

export function classifyFormat(mimeType: string): DocumentFormat {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (mime === PDF_MIME) return 'PDF';
  // Checked before the text/* rule below: RTF and HTML are text on the wire but office documents to
  // the converter, and reading them raw would put markup into the search index.
  if (OFFICE_MIMES.has(mime)) return 'OFFICE';
  if (TEXT_MIMES.has(mime)) return 'TEXT';
  // An image the tooling can actually open; SVG is markup and sharp rasterizes it, but a document
  // library has no use for that, so it is left unsupported.
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'IMAGE';
  if (mime.startsWith('text/')) return 'TEXT';

  // Registered, listed and downloadable — but with no representation Legere can build (docs/05 §5.5).
  return 'UNSUPPORTED';
}
