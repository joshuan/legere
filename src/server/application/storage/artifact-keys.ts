// The S3 key layout (docs/09 §9.2) is deterministic: derived from the document id alone, never
// stored in a column. Every producer and consumer of an artifact goes through these helpers, so the
// layout is stated once.
export const artifactKeys = {
  // Canonicalized PDF (office → PDF); absent when the source is already PDF/text/image.
  canonicalPdf: (documentId: string): string => `documents/${documentId}/canonical.pdf`,
  // First page, PREVIEW_MAX_DIM.
  preview: (documentId: string): string => `documents/${documentId}/preview.jpg`,
  // First page, THUMB_MAX_DIM.
  thumbnail: (documentId: string): string => `documents/${documentId}/thumb.jpg`,
  // DERIVED documents only: the merged scan-set PDF, which is the source itself.
  derivedSource: (documentId: string): string => `documents/${documentId}/source.pdf`,
  // Everything belonging to one document, for maintenance sweeps.
  documentPrefix: (documentId: string): string => `documents/${documentId}/`,
} as const;
