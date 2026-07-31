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
