import { describe, expect, it } from 'vitest';
import {
  artifactKeys,
  originalDelivery,
  originalKeyOf,
  servableContentType,
} from './artifact-keys';

// The layout is a persistence format: changing a key orphans every artifact already in the bucket,
// so it is pinned here against docs/09 §9.2 rather than left to be re-derived.
describe('artifactKeys', () => {
  const documentId = '0f4a3d2c-1111-4111-8111-111111111111';
  const fileId = '0f4a3d2c-2222-4222-8222-222222222222';

  it('lays every artifact of one document out under its own prefix', () => {
    expect(artifactKeys.canonicalPdf(documentId)).toBe(`documents/${documentId}/canonical.pdf`);
    expect(artifactKeys.preview(documentId)).toBe(`documents/${documentId}/preview.jpg`);
    expect(artifactKeys.thumbnail(documentId)).toBe(`documents/${documentId}/thumb.jpg`);

    const prefix = artifactKeys.documentPrefix(documentId);
    for (const key of [
      artifactKeys.canonicalPdf(documentId),
      artifactKeys.preview(documentId),
      artifactKeys.thumbnail(documentId),
    ]) {
      expect(key.startsWith(prefix)).toBe(true);
    }
  });

  // A document owns no source bytes of its own: those belong to its files (docs/03 §3.3.10).
  it('addresses a managed file by its own id', () => {
    expect(artifactKeys.fileOriginal(fileId, 'jpg')).toBe(`files/${fileId}/original.jpg`);
    expect(artifactKeys.fileOriginal(fileId, '')).toBe(`files/${fileId}/original.bin`);
    expect(
      artifactKeys.fileOriginal(fileId, 'jpg').startsWith(artifactKeys.filePrefix(fileId)),
    ).toBe(true);
  });

  // A picture of one page of that file's own original, 0-based the way a page order counts
  // (docs/03 §3.3.16, docs/09 §9.2). Under the file's prefix, so emptying the trash and the orphan
  // sweep both take it with the file.
  it('lays a page of one file out under that file', () => {
    expect(artifactKeys.filePageThumb(fileId, 0)).toBe(`files/${fileId}/pages/0.jpg`);
    expect(artifactKeys.filePageThumb(fileId, 41)).toBe(`files/${fileId}/pages/41.jpg`);
    expect(artifactKeys.filePageThumb(fileId, 0).startsWith(artifactKeys.filePrefix(fileId))).toBe(
      true,
    );
  });

  it('prefers the key a file recorded over the one the layout would give it', () => {
    expect(originalKeyOf({ id: fileId, ext: 'pdf', storageKey: 'files/older/layout.pdf' })).toBe(
      'files/older/layout.pdf',
    );
    expect(originalKeyOf({ id: fileId, ext: 'pdf', storageKey: null })).toBe(
      `files/${fileId}/original.pdf`,
    );
  });

  it('keeps documents apart', () => {
    expect(artifactKeys.preview('doc-a')).not.toBe(artifactKeys.preview('doc-b'));
  });
});

// 🔒 The rule that stops an uploaded file being served as something a browser will run (SEC-03).
describe('servableContentType', () => {
  it('serves the canonical PDF and real pictures as themselves', () => {
    expect(servableContentType('application/pdf')).toBe('application/pdf');
    expect(servableContentType('image/jpeg')).toBe('image/jpeg');
    expect(servableContentType('image/png')).toBe('image/png');
    // Not on any hand-written list, and it must still draw: the product offers to crop it.
    expect(servableContentType('image/avif')).toBe('image/avif');
    expect(servableContentType('image/bmp')).toBe('image/bmp');
  });

  it('refuses to call anything a document a browser would render', () => {
    expect(servableContentType('text/html')).toBe('application/octet-stream');
    expect(servableContentType('application/xml')).toBe('application/octet-stream');
    expect(servableContentType('text/xml')).toBe('application/octet-stream');
    expect(servableContentType('application/xhtml+xml')).toBe('application/octet-stream');
  });

  // An image that is a document that can carry script. The one image type held back.
  it('never serves an SVG as an SVG', () => {
    expect(servableContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(servableContentType('IMAGE/SVG+XML')).toBe('application/octet-stream');
  });

  it('reads the type without its parameters, and without caring about case', () => {
    expect(servableContentType('image/PNG; charset=binary')).toBe('image/png');
    expect(servableContentType('  application/pdf  ')).toBe('application/pdf');
    expect(servableContentType('')).toBe('application/octet-stream');
  });
});

describe('originalDelivery', () => {
  it('offers whatever a person uploaded as something to save, under the name it arrived with', () => {
    expect(originalDelivery({ mimeType: 'text/html', name: 'report.html' })).toEqual({
      disposition: 'attachment',
      contentType: 'application/octet-stream',
      fileName: 'report.html',
    });
  });

  it('still says what a picture is, so the crop editor can load it', () => {
    expect(originalDelivery({ mimeType: 'image/png', name: 'scan.png' })).toEqual({
      disposition: 'attachment',
      contentType: 'image/png',
      fileName: 'scan.png',
    });
  });
});
