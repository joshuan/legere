import {
  isIdentityRotation,
  type Crop,
  type PageOrder,
  type PageRotations,
  type Rotation,
} from '../../../shared/contracts/documents';
import type { FileOrigin, TrashReason, ValueSource } from '../../../shared/contracts/enums';

// A file: the bytes themselves, once, however many places they turn up in (docs/03 §3.3.16).
// What a person reads is a Document, which is an ordered list of these plus a canonical PDF.
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
  crop: Crop | null;
  cropSource: ValueSource;
  // Which way up this file lies (docs/03 §3.3.16): a quarter turn and a mirror, null for the way it
  // arrived. Meaningful only for an image, exactly as a crop is, and never a change to the bytes —
  // the build applies it after the crop and the original stays the original.
  rotation: Rotation | null;
  // The pages inside this one file (docs/03 §3.3.16). `pageOrder` is a permutation of its 0-based
  // page indices, null for the order they arrived in; `pageRotations` is one quarter turn per page,
  // null for the way they arrived; `pageCount` is how many the last canonical build counted, null
  // until one has. All three are meaningful only for a PDF, exactly as a crop is meaningful only for
  // an image, and none of them is ever a change to the bytes.
  pageOrder: PageOrder | null;
  pageRotations: PageRotations | null;
  pageCount: number | null;
  // In the trash since, and how it got there (docs/05 §5.7a). A file is part of exactly one document
  // or it is in here; nothing else is a place for a file to be.
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

// A crop a person dragged is never replaced by a machine (docs/03 §3.3.16).
export function canOverwriteCrop(file: Pick<File, 'cropSource'>): boolean {
  return file.cropSource !== 'MANUAL';
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

// The order a build should read this file's pages in, or `null` for "as they arrived". A stored
// order that does not describe the pages just counted — a row written by another version, a count
// that has moved — is no order at all: the pages stand as they are and the document is still the
// document, exactly as an unreadable crop leaves the whole image in place (docs/05 §5.5 step 1.1).
export function effectivePageOrder(
  file: Pick<File, 'pageOrder'>,
  pageCount: number,
): readonly number[] | null {
  if (file.pageOrder === null) return null;
  if (!isPagePermutation(file.pageOrder, pageCount)) return null;
  // The natural order is not worth a call to Stirling.
  if (file.pageOrder.every((index, position) => index === position)) return null;
  return file.pageOrder;
}

// Whether a list of turns describes the pages of a file of `pageCount` pages: one quarter turn each,
// in the file's own page order (docs/07 §7.3). The values themselves are 0…3 by the contract, so
// what is left to check is that there are exactly as many of them as there are pages.
export function isPageRotationList(rotations: readonly number[], pageCount: number): boolean {
  if (rotations.length !== pageCount) return false;
  return rotations.every((turn) => Number.isInteger(turn) && turn >= 0 && turn <= 3);
}

// The turn a build should apply to this image, or `null` for "the way it arrived" — which covers
// both a file that carries none and one whose turns were pressed round in a circle, because a
// quarter turn of nothing is not worth re-encoding a page for (docs/05 §5.5 step 1).
export function effectiveRotation(file: Pick<File, 'rotation'>): Rotation | null {
  return isIdentityRotation(file.rotation) ? null : file.rotation;
}

// The page turns a build should apply, or `null` for "as they arrived". A list that does not
// describe the pages just counted — a file replaced by different bytes under a stored one, a row
// written by another version — is no list at all, exactly as an order that does not fit is no order
// (docs/05 §5.5 step 1.1). Nor is a list in which nothing is turned.
export function effectivePageRotations(
  file: Pick<File, 'pageRotations'>,
  pageCount: number,
): readonly number[] | null {
  if (file.pageRotations === null) return null;
  if (!isPageRotationList(file.pageRotations, pageCount)) return null;
  if (file.pageRotations.every((turn) => turn === 0)) return null;
  return file.pageRotations;
}
