import type { Crop } from '../../../shared/contracts/documents';
import type { FileOrigin, ValueSource } from '../../../shared/contracts/enums';

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
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

// Only an image can be cropped, and only an image becomes a page by being laid on one (docs/05 §5.5).
export function isImageFile(file: Pick<File, 'mimeType'>): boolean {
  return file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml';
}

// A crop a person dragged is never replaced by a machine (docs/03 §3.3.16).
export function canOverwriteCrop(file: Pick<File, 'cropSource'>): boolean {
  return file.cropSource !== 'MANUAL';
}
