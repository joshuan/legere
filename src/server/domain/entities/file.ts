import type { Crop } from '../../../shared/contracts/documents';
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
