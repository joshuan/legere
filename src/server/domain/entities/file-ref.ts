import type { FileRefStatus } from '../../../shared/contracts/enums';
import type { RelativePath } from '../value-objects/relative-path';

// FileRef entity (docs/03 §3.3.9): a physical file inside a library. No soft delete — the lifecycle
// is expressed by `status`.
export type FileRef = {
  id: string;
  libraryId: string;
  path: RelativePath;
  size: bigint;
  mtimeMs: number;
  status: FileRefStatus;
  contentHash: string | null;
  // The file these bytes are, set when HASHED (docs/03 §3.3.9). A ref points at a file, and the
  // file is what a document holds.
  fileId: string | null;
  missingSince: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

// The incremental scan compares path + size + mtime and only re-reads content when one of them moved
// (docs/05 §5.2). Comparing mtime in whole milliseconds matches what the filesystem reports and what
// is stored, so an unchanged file never looks changed.
export function needsRehash(ref: FileRef, size: bigint, mtimeMs: number): boolean {
  // 🔒 An excluded path is read again only when the bytes at it have moved (docs/05 §5.2). It points
  // at no file, so every other rule here would say "rehash" — and rehashing it is exactly how a
  // document an admin deleted would come back on the next scan, the volume being read-only and the
  // original still lying on it (docs/03 §3.3.9). Different bytes at that path are a different file
  // and are ingested like any other.
  if (ref.status === 'EXCLUDED') return changed(ref, size, mtimeMs);
  if (ref.status !== 'HASHED') return true;
  if (ref.contentHash === null || ref.fileId === null) return true;
  return changed(ref, size, mtimeMs);
}

function changed(ref: FileRef, size: bigint, mtimeMs: number): boolean {
  return ref.size !== size || Math.trunc(ref.mtimeMs) !== Math.trunc(mtimeMs);
}

// State machine (docs/03 §3.3.9): DISCOVERED → HASHED, HASHED → MISSING, MISSING → HASHED (the file
// came back), HASHED → DISCOVERED (size/mtime moved, so re-hash). Any state may become EXCLUDED,
// because a document may be deleted whatever its files happen to be doing at that moment.
export function canTransition(from: FileRefStatus, to: FileRefStatus): boolean {
  if (from === to) return true;
  const allowed: Record<FileRefStatus, FileRefStatus[]> = {
    DISCOVERED: ['HASHED', 'MISSING', 'EXCLUDED'],
    HASHED: ['DISCOVERED', 'MISSING', 'EXCLUDED'],
    // A returned file is re-hashed before it counts as HASHED again, so it goes back through
    // DISCOVERED; attaching it directly is also allowed when the hash is already known.
    MISSING: ['DISCOVERED', 'HASHED', 'EXCLUDED'],
    // The one way out: the bytes at that path changed, so what is there now was never deleted. It
    // goes back through DISCOVERED like anything else whose content is unknown.
    EXCLUDED: ['DISCOVERED'],
  };
  return allowed[from].includes(to);
}

// A ref points at real, readable content only while it is HASHED and attached to a file; this is what
// a document's availability is computed from, one file at a time (docs/03 §3.3.10).
export function isLive(ref: FileRef): boolean {
  return ref.status === 'HASHED' && ref.fileId !== null;
}
