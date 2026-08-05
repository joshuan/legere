// The S3 key layout (docs/09 §9.2). A document's artifacts are deterministic from its id; a managed
// file's own bytes are addressed by the file id and the key is recorded on the row, so a key written
// by an older version keeps resolving. Every producer and consumer goes through these helpers, so
// the layout is stated once.
export const artifactKeys = {
  // Canonicalized PDF: every document has one, built from its files (docs/05 §5.5).
  canonicalPdf: (documentId: string): string => `documents/${documentId}/canonical.pdf`,
  // First page, PREVIEW_MAX_DIM.
  preview: (documentId: string): string => `documents/${documentId}/preview.jpg`,
  // First page, THUMB_MAX_DIM.
  thumbnail: (documentId: string): string => `documents/${documentId}/thumb.jpg`,
  // A MANAGED file's own bytes: an upload, or something we made (docs/09 §9.2). A LIBRARY file has
  // no object at all — its bytes stay on the volume.
  fileOriginal: (fileId: string, ext: string): string =>
    `files/${fileId}/original.${ext === '' ? 'bin' : ext}`,
  // Everything belonging to one document, for maintenance sweeps.
  documentPrefix: (documentId: string): string => `documents/${documentId}/`,
  // The same for one file.
  filePrefix: (fileId: string): string => `files/${fileId}/`,
} as const;

// Where one managed file's bytes are: what the row recorded, or — for a row written before the key
// was known, since the key contains the id the database assigns — the layout above (docs/09 §9.2).
export function originalKeyOf(file: {
  id: string;
  ext: string;
  storageKey: string | null;
}): string {
  return file.storageKey ?? artifactKeys.fileOriginal(file.id, file.ext);
}
