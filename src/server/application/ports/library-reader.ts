import type { Readable } from 'node:stream';
import type { RelativePath } from '../../domain/value-objects/relative-path';

// Read-only access to a library volume (docs/06 §6.3.3, docs/09 §9.1). The volume is mounted `:ro`,
// so this port exposes no way to write — the absence of a write method is part of the contract.

// What the library a caller is reading is rooted at; `rootPath` is relative to LIBRARY_ROOT.
export type LibraryLocation = {
  rootPath: RelativePath;
  excludeGlobs: readonly string[];
};

export type FsEntry = {
  relPath: RelativePath;
  size: bigint;
  mtimeMs: number;
};

export type FsDirectoryEntry = {
  name: string;
  isDirectory: boolean;
};

// Directories that could not be read are reported rather than aborting a scan (docs/09 §9.1).
export type WalkError = {
  relPath: string;
  message: string;
};

export type WalkResult = {
  entries: AsyncIterable<FsEntry>;
  // Populated while the iterable is consumed; read it after the walk completes.
  errors: WalkError[];
};

export abstract class LibraryReader {
  // Null when the path does not exist, is not a regular file, or is excluded.
  abstract stat(library: LibraryLocation, relPath: RelativePath): Promise<FsEntry | null>;

  // Immediate children of a directory, used by the admin path picker (docs/07 admin libraries).
  abstract list(library: LibraryLocation, relPath: RelativePath): Promise<FsDirectoryEntry[]>;

  abstract openStream(library: LibraryLocation, relPath: RelativePath): Promise<Readable>;

  // Depth-first, name-sorted walk so scans are deterministic (docs/09 §9.1).
  abstract walk(library: LibraryLocation): WalkResult;

  // True when the path resolves to an existing directory inside LIBRARY_ROOT — the library-creation
  // invariant of docs/03 §3.3.6.
  abstract isDirectory(relPath: RelativePath): Promise<boolean>;
}
