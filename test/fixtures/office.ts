import { readFile } from 'node:fs/promises';

// Synthetic Word fixtures: two paragraphs separated by a page break, a heading and a small table.
// DOCX is a minimal OOXML package; DOC is its macOS textutil conversion. The late-metadata variant
// adds an uncompressed 16 KiB ZIP entry before [Content_Types].xml to defeat prefix-only detection.
export function wordFixture(format: 'doc' | 'docx' | 'late-docx'): Promise<Buffer> {
  const name = format === 'late-docx' ? 'word-late-metadata.docx' : `word.${format}`;
  return readFile(`test/fixtures/${name}`);
}

// The smallest office document that is still a real one: RTF is a text format LibreOffice converts
// through exactly the same filter chain as DOCX, so the office → PDF path can be exercised without
// checking a binary blob into the repository.
export function rtfWithText(text: string): Buffer {
  const escaped = text.replace(/([\\{}])/g, '\\$1');
  return Buffer.from(
    `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0\\fs40 ${escaped}\\par}`,
    'ascii',
  );
}
