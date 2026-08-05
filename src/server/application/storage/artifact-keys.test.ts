import { describe, expect, it } from 'vitest';
import { artifactKeys, originalKeyOf } from './artifact-keys';

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
