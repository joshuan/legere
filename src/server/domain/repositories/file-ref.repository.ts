import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { FileRef } from '../entities/file-ref';
import type { FileRefView } from './file.repository';
import type { RelativePath } from '../value-objects/relative-path';

export type CreateFileRefInput = {
  libraryId: string;
  path: RelativePath;
  size: bigint;
  mtimeMs: number;
  seenAt: Date;
};

// What the scan needs to know about a known ref to run the §5.2 diff, without loading everything.
export type FileRefSnapshot = {
  id: string;
  path: string;
  size: bigint;
  mtimeMs: number;
  status: FileRef['status'];
  contentHash: string | null;
  fileId: string | null;
};

// A folder in the browse view (docs/11 §11.4). Folders are not stored: they are the distinct next
// path segments of the refs a scan recorded.
export type FolderSummary = {
  name: string;
  documentCount: number;
};

export abstract class FileRefRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<FileRef | null>;

  // Immediate subfolders of `folder` in a library, with how many documents live anywhere beneath
  // each of them — a folder that only contains folders is still worth showing.
  abstract listFoldersUnder(
    libraryId: string,
    folder: string,
    tx?: TransactionHandle,
  ): Promise<FolderSummary[]>;

  // Where to read a LIBRARY file's own bytes — for building the canonical, and for the download of
  // one original (docs/09 §9.1): the first HASHED ref in a library that is still active. A file is
  // asked, not a document, because a document is many files and each has its own homes.
  abstract findLiveRefForFile(fileId: string, tx?: TransactionHandle): Promise<FileRef | null>;

  abstract findByPath(
    libraryId: string,
    path: RelativePath,
    tx?: TransactionHandle,
  ): Promise<FileRef | null>;

  // Every ref of a library, for the scan diff. Loaded in one pass — acceptable at self-hosted scale
  // and far cheaper than a query per file (docs/05 §5.2).
  abstract snapshotForLibrary(
    libraryId: string,
    tx?: TransactionHandle,
  ): Promise<FileRefSnapshot[]>;

  abstract create(input: CreateFileRefInput, tx?: TransactionHandle): Promise<FileRef>;

  // The file moved or changed: back to DISCOVERED so ingest re-hashes it (docs/03 §3.3.9).
  abstract markDiscovered(
    id: string,
    size: bigint,
    mtimeMs: number,
    seenAt: Date,
    tx?: TransactionHandle,
  ): Promise<void>;

  // Ingest finished: the ref now points at the file its bytes are (docs/05 §5.3).
  abstract markHashed(
    id: string,
    contentHash: string,
    fileId: string,
    size: bigint,
    mtimeMs: number,
    tx?: TransactionHandle,
  ): Promise<void>;

  // Unchanged since the last scan — only the sighting is recorded.
  abstract touchSeen(ids: string[], seenAt: Date, tx?: TransactionHandle): Promise<void>;

  // Gone from disk (docs/05 §5.7). Data is never deleted; the ref just stops being live.
  abstract markMissing(ids: string[], missingSince: Date, tx?: TransactionHandle): Promise<number>;

  // 🔒 The document these files were part of was deleted (docs/03 §3.3.9). The refs stay — pointing
  // at no file, since the file rows go — and become the tombstone that keeps the next scan from
  // ingesting the same bytes into a new document. Addressed by file rather than by ref: every path
  // the bytes were seen at is excluded at once, so a second copy on another volume does not walk the
  // document back in. Runs before the files are deleted, or the foreign key would refuse.
  abstract markExcluded(fileIds: readonly string[], tx?: TransactionHandle): Promise<void>;

  // The other way: a file restored from the trash gets its paths back (docs/05 §5.7a). Addressed by
  // content hash rather than by file id, because excluding a ref is what cleared `fileId` — the hash
  // is what survived, and it is what says these paths hold exactly these bytes.
  abstract markRestored(fileId: string, contentHash: string, tx?: TransactionHandle): Promise<void>;

  // Everywhere one file's bytes were seen, unfiltered: what the trash needs to hand them back
  // (docs/07 §7.3). Every caller of this one is an admin, who may see every library anyway.
  abstract listForFile(
    fileId: string,
    contentHash: string,
    tx?: TransactionHandle,
  ): Promise<FileRefView[]>;
}
