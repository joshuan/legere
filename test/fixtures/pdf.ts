// Minimal, valid PDFs built byte by byte, so the fixtures used by the PDF tests are readable in the
// diff instead of being opaque binaries in the repository. Uncompressed and with a correct xref
// table — both pdfjs (our extractor) and PDFBox (Stirling's engine) parse them.

// One page per string, each drawn with the base-14 Helvetica font: the text comes back out of the
// extractor exactly as it went in, which is what makes per-page assertions meaningful.
export function pdfWithText(pages: readonly string[]): Buffer {
  const pageCount = Math.max(1, pages.length);
  const contents = Array.from({ length: pageCount }, (_, index) =>
    contentStream(pages[index] ?? ''),
  );

  // Object ids: 1 catalog, 2 page tree, 3 font, then a page and a content stream per page.
  const fontId = 3;
  const pageId = (index: number): number => 4 + index * 2;
  const contentId = (index: number): number => 5 + index * 2;

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];

  for (let index = 0; index < pageCount; index += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId(index)} 0 R >>`,
    );
    const stream = contents[index] ?? '';
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }

  return assemble(objects);
}

function contentStream(text: string): string {
  return `BT /F1 24 Tf 72 700 Td (${escapeText(text)}) Tj ET`;
}

// Parentheses and backslashes end or escape a PDF string literal, so they have to be escaped.
function escapeText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

// Writes the body, then the cross-reference table pointing at every object's byte offset.
function assemble(objects: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let offset = parts[0]?.length ?? 0;

  objects.forEach((body, index) => {
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`);
    offsets.push(offset);
    offset += chunk.length;
    parts.push(chunk);
  });

  const size = objects.length + 1;
  const xref = [
    'xref',
    `0 ${size}`,
    '0000000000 65535 f ',
    ...offsets.map((value) => `${value.toString().padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${size} /Root 1 0 R >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');

  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}
