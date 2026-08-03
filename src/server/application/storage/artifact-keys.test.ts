import { describe, expect, it } from 'vitest';
import { artifactKeys } from './artifact-keys';

// The layout is a persistence format: changing a key orphans every artifact already in the bucket,
// so it is pinned here against docs/09 §9.2 rather than left to be re-derived.
describe('artifactKeys', () => {
  const documentId = '0f4a3d2c-1111-4111-8111-111111111111';

  it('lays every artifact of one document out under its own prefix', () => {
    expect(artifactKeys.canonicalPdf(documentId)).toBe(`documents/${documentId}/canonical.pdf`);
    expect(artifactKeys.preview(documentId)).toBe(`documents/${documentId}/preview.jpg`);
    expect(artifactKeys.thumbnail(documentId)).toBe(`documents/${documentId}/thumb.jpg`);
    expect(artifactKeys.source(documentId, 'pdf')).toBe(`documents/${documentId}/source.pdf`);

    const prefix = artifactKeys.documentPrefix(documentId);
    for (const key of [
      artifactKeys.canonicalPdf(documentId),
      artifactKeys.preview(documentId),
      artifactKeys.thumbnail(documentId),
      artifactKeys.source(documentId, 'pdf'),
    ]) {
      expect(key.startsWith(prefix)).toBe(true);
    }
  });

  it('keeps documents apart', () => {
    expect(artifactKeys.preview('doc-a')).not.toBe(artifactKeys.preview('doc-b'));
  });
});
