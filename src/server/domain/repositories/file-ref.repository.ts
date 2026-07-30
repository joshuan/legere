import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { FileRef } from '../entities/file-ref';
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
  documentId: string | null;
};

export abstract class FileRefRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<FileRef | null>;

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

  // Ingest finished: the ref now points at a document by content (docs/05 §5.3).
  abstract markHashed(
    id: string,
    contentHash: string,
    documentId: string,
    size: bigint,
    mtimeMs: number,
    tx?: TransactionHandle,
  ): Promise<void>;

  // Unchanged since the last scan — only the sighting is recorded.
  abstract touchSeen(ids: string[], seenAt: Date, tx?: TransactionHandle): Promise<void>;

  // Gone from disk (docs/05 §5.7). Data is never deleted; the ref just stops being live.
  abstract markMissing(ids: string[], missingSince: Date, tx?: TransactionHandle): Promise<number>;

  // Availability of a document: how many of its refs are live in an active, non-deleted library
  // (docs/03 §3.3.10).
  abstract countLiveRefsInActiveLibraries(
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<number>;
}
