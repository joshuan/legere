import { describe, expect, it } from 'vitest';
import { FileTypeMimeDetector } from './file-type-mime-detector';

const detector = new FileTypeMimeDetector();

// Real signatures, as they appear at the start of a file.
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n', 'binary');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
// Signature plus a complete IHDR chunk: detection walks the chunk list, so the header must be whole.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(13),
  Buffer.alloc(4),
]);

// Content decides, the extension is only the fallback where there are no magic bytes
// (docs/06 §6.3.3, docs/03 §3.3.10).
describe('FileTypeMimeDetector', () => {
  it('detects a PDF from its magic bytes', async () => {
    expect(await detector.detect(PDF, 'invoice.pdf')).toEqual({
      mime: 'application/pdf',
      ext: 'pdf',
    });
  });

  it('believes the bytes over the file name', async () => {
    // A JPEG named .pdf must be processed as an image, not handed to a PDF tool.
    expect(await detector.detect(JPEG, 'scan.pdf')).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(await detector.detect(PNG, 'notes.txt')).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('falls back to the extension for text, which has no signature', async () => {
    const markdown = Buffer.from('# Title\n\nSome notes.\n');

    expect(await detector.detect(markdown, 'notes.md')).toEqual({
      mime: 'text/markdown',
      ext: 'md',
    });
    expect(await detector.detect(Buffer.from('plain'), 'a.txt')).toEqual({
      mime: 'text/plain',
      ext: 'txt',
    });
    expect(await detector.detect(Buffer.from('a,b\n1,2\n'), 'rows.CSV')).toEqual({
      mime: 'text/csv',
      ext: 'csv',
    });
  });

  it('refuses the text fallback when the content is binary', async () => {
    // A NUL byte contradicts the .txt claim, so the file is not fed to the text pipeline.
    const binary = Buffer.from([0x01, 0x00, 0x02, 0x03]);

    expect(await detector.detect(binary, 'looks-like.txt')).toEqual({
      mime: 'application/octet-stream',
      ext: 'txt',
    });
  });

  it('treats an empty file named as text as text', async () => {
    expect(await detector.detect(Buffer.alloc(0), 'empty.txt')).toEqual({
      mime: 'text/plain',
      ext: 'txt',
    });
  });

  it('survives a head too short to complete a signature', async () => {
    // file-type reads through a tokenizer and throws End-Of-Stream on a truncated match; ingest of a
    // two-byte file must fall through to the extension instead of failing.
    expect(await detector.detect(Buffer.from([0xff, 0xd8]), 'tiny.jpg')).toEqual({
      mime: 'application/octet-stream',
      ext: 'jpg',
    });
  });

  it('reports unknown content with no extension as opaque bytes', async () => {
    expect(await detector.detect(Buffer.from([0x7f, 0x11, 0x22, 0x33]), 'README')).toEqual({
      mime: 'application/octet-stream',
      ext: '',
    });
  });

  it('ignores a leading dot, which is a hidden file and not an extension', async () => {
    expect(await detector.detect(Buffer.from('SECRET=1'), '.env')).toEqual({
      mime: 'application/octet-stream',
      ext: '',
    });
  });
});
