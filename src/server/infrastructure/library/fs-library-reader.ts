import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import picomatch from 'picomatch';
import {
  LibraryReader,
  type FsDirectoryEntry,
  type FsEntry,
  type LibraryLocation,
  type WalkError,
  type WalkResult,
} from '../../application/ports/library-reader';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { AppConfig } from '../config/app-config';

// Hidden files and directories are skipped by default (docs/09 §9.1); excludeGlobs add to that.
const HIDDEN_PREFIX = '.';

@Injectable()
export class FsLibraryReader extends LibraryReader {
  private readonly libraryRoot: string;

  constructor(config: AppConfig) {
    super();
    this.libraryRoot = resolve(config.get('LIBRARY_ROOT'));
  }

  async stat(library: LibraryLocation, relPath: RelativePath): Promise<FsEntry | null> {
    if (this.isExcluded(library, relPath)) return null;

    const absolute = this.absolutePath(library, relPath);
    const stats = await lstat(absolute).catch(() => null);
    // lstat, not stat: a symlink must read as "not a file" rather than being followed (🔒 docs/09 §9.1).
    if (stats === null || !stats.isFile()) return null;

    return { relPath, size: BigInt(stats.size), mtimeMs: stats.mtimeMs };
  }

  async list(library: LibraryLocation, relPath: RelativePath): Promise<FsDirectoryEntry[]> {
    const absolute = this.absolutePath(library, relPath);
    const dirents = await readdir(absolute, { withFileTypes: true }).catch(() => []);

    return (
      dirents
        .filter((dirent) => !dirent.name.startsWith(HIDDEN_PREFIX))
        // Symlinks are neither listed nor followed, so a link cannot smuggle in an outside tree.
        .filter((dirent) => dirent.isDirectory() || dirent.isFile())
        .filter((dirent) => !this.isExcluded(library, relPath.join(dirent.name)))
        .map((dirent) => ({ name: dirent.name, isDirectory: dirent.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  async openStream(library: LibraryLocation, relPath: RelativePath): Promise<Readable> {
    const absolute = this.absolutePath(library, relPath);
    const stats = await lstat(absolute);
    if (!stats.isFile()) throw new Error(`Not a regular file: ${relPath.value}`);
    return createReadStream(absolute);
  }

  walk(library: LibraryLocation): WalkResult {
    const errors: WalkError[] = [];
    return { entries: this.walkDirectory(library, RelativePath.root(), errors), errors };
  }

  async isDirectory(relPath: RelativePath): Promise<boolean> {
    const absolute = this.resolveInsideRoot(this.libraryRoot, relPath);
    const stats = await lstat(absolute).catch(() => null);
    return stats !== null && stats.isDirectory();
  }

  // Depth-first and name-sorted, so two scans of an unchanged tree produce identical sequences
  // (docs/09 §9.1). An unreadable directory is recorded and skipped rather than aborting the scan.
  private async *walkDirectory(
    library: LibraryLocation,
    directory: RelativePath,
    errors: WalkError[],
  ): AsyncGenerator<FsEntry> {
    const absolute = this.absolutePath(library, directory);

    let dirents;
    try {
      dirents = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      errors.push({
        relPath: directory.value,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of sorted) {
      if (dirent.name.startsWith(HIDDEN_PREFIX)) continue;

      // Anything that is not a plain file or directory — symlinks, sockets, FIFOs, devices — is
      // skipped outright (🔒 docs/09 §9.1).
      if (!dirent.isFile() && !dirent.isDirectory()) continue;

      const child = directory.join(dirent.name);
      if (this.isExcluded(library, child)) continue;

      if (dirent.isDirectory()) {
        yield* this.walkDirectory(library, child, errors);
        continue;
      }

      const stats = await lstat(join(absolute, dirent.name)).catch(() => null);
      if (stats === null || !stats.isFile()) continue;
      yield { relPath: child, size: BigInt(stats.size), mtimeMs: stats.mtimeMs };
    }
  }

  private isExcluded(library: LibraryLocation, relPath: RelativePath): boolean {
    if (relPath.segments.some((segment) => segment.startsWith(HIDDEN_PREFIX))) return true;
    if (library.excludeGlobs.length === 0) return false;
    return picomatch.isMatch(relPath.value, [...library.excludeGlobs], { dot: true });
  }

  // LIBRARY_ROOT + library.rootPath + relPath, re-verified to still be inside the library root
  // (🔒 docs/09 §9.1). RelativePath already rejects traversal; this is the second, independent check.
  private absolutePath(library: LibraryLocation, relPath: RelativePath): string {
    const libraryBase = this.resolveInsideRoot(this.libraryRoot, library.rootPath);
    return this.resolveInsideRoot(libraryBase, relPath);
  }

  private resolveInsideRoot(base: string, relPath: RelativePath): string {
    const candidate = resolve(base, relPath.value);
    if (!isInside(base, candidate)) {
      throw new Error(`Path escapes its root: ${relPath.value}`);
    }
    return candidate;
  }
}

function isInside(base: string, candidate: string): boolean {
  if (candidate === base) return true;
  const rel = relative(base, candidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

// Exported for the library-creation check: a rootPath may be given as a real path that resolves —
// via symlinks — outside the volume, which must be refused (🔒 docs/05 §5.1).
export async function resolvesInsideRoot(root: string, absolute: string): Promise<boolean> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(resolve(root)).catch(() => null),
    realpath(absolute).catch(() => null),
  ]);
  if (realRoot === null || realTarget === null) return false;
  return isInside(realRoot, realTarget);
}
