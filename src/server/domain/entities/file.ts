import type { FileOrigin, TrashReason } from '../../../shared/contracts/enums';

// A file: the bytes themselves, once, however many places they turn up in (docs/03 §3.3.16).
// What a person reads is a Document, which is an ordered list of **pages** read out of files, plus a
// canonical PDF built from them (ADR-025). Since that decision a file says nothing about any
// document — no crop, no turn, no page order — and carries only what describes its bytes.
export type File = {
  id: string;
  contentHash: string;
  origin: FileOrigin;
  // Where a MANAGED file's bytes are; null for a LIBRARY file, whose bytes stay on the volume.
  // Stored rather than derived, so a key written by an older version keeps working (docs/09 §9.2).
  storageKey: string | null;
  mimeType: string;
  ext: string;
  sizeBytes: bigint;
  name: string;
  // How many pages are inside these bytes (docs/03 §3.3.16): an image is one, a PDF is what its page
  // tree says, an office document is what the converter laid it out as. Null until a canonical build
  // has counted — and while it is null a document cannot name this file's pages one by one, so it
  // holds it as a single entry standing for it whole (docs/03 §3.3.17).
  pageCount: number | null;
  // In the trash since, and how it got there (docs/05 §5.7a). A file with no live page in any
  // document is in here; nothing else is a place for a file to be.
  trashedAt: Date | null;
  trashedReason: TrashReason | null;
  // The title the document had when the file left it — a record and not a link, because that
  // document is usually gone by the time anybody reads the trash.
  trashedFrom: string | null;
  // For REPLACED: the file that took this one's place. Points at the file in the document *now*, so
  // the versions of a page are one query however many times it has been replaced (docs/03 §3.3.16).
  replacedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

// Where a file belongs (docs/03 §3.3.16): a document, or the trash. Asked by ingest, which must not
// hand a thrown-away scan a fresh document every time the volume's mtime moves (docs/05 §5.3).
export function isTrashed(file: Pick<File, 'trashedAt'>): boolean {
  return file.trashedAt !== null;
}

// When the sweep may delete a file of ours, and never for a library original: its bytes are on a
// read-only volume, so no window closes on them and the trash says so instead of counting down
// (docs/05 §5.7a).
export function purgeAfterOf(
  file: Pick<File, 'origin' | 'trashedAt'>,
  retentionDays: number,
): Date | null {
  if (file.origin !== 'MANAGED' || file.trashedAt === null) return null;
  return new Date(file.trashedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

// Only an image can be cropped, and only an image becomes a page by being laid on one (docs/05 §5.5).
export function isImageFile(file: Pick<File, 'mimeType'>): boolean {
  return file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml';
}

// Only a PDF has pages to put in order: an image is one page, a format nothing renders is none
// (docs/03 §3.3.16). Asked of the detected type on the row, like every other question about what a
// file is.
export function isPdfFile(file: Pick<File, 'mimeType'>): boolean {
  return file.mimeType.split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}

// Whether a list of indices is exactly the pages of a file of `pageCount` pages, each once — which
// is the whole of what makes a stored page order storable (docs/07 §7.3). A short list, a repeated
// index and an index past the end are the three ways to get it wrong, and this refuses all three by
// answering the one question that covers them: is every page named, once?
export function isPagePermutation(order: readonly number[], pageCount: number): boolean {
  if (order.length !== pageCount) return false;
  const seen = new Set<number>();
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) return false;
    if (seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

// Whether a list of turns describes the pages of a file of `pageCount` pages: one quarter turn each,
// in the file's own page order (docs/07 §7.3). The values themselves are 0…3 by the contract, so
// what is left to check is that there are exactly as many of them as there are pages.
export function isPageRotationList(rotations: readonly number[], pageCount: number): boolean {
  if (rotations.length !== pageCount) return false;
  return rotations.every((turn) => Number.isInteger(turn) && turn >= 0 && turn <= 3);
}
