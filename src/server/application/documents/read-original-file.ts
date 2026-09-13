import type { File } from '../../domain/entities/file';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import type { BinarySource } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { LibraryReader } from '../ports/library-reader';
import { originalKeyOf } from '../storage/artifact-keys';

// Background processing has no viewer: it reads the first live home of the original, unchanged.
export async function readOriginalFile(
  file: File,
  fileRefs: FileRefRepository,
  libraries: LibraryRepository,
  reader: LibraryReader,
  storage: FileStorage,
): Promise<BinarySource> {
  if (file.origin === 'MANAGED') return storage.getStream(originalKeyOf(file));
  const ref = await fileRefs.findLiveRefForFile(file.id);
  if (ref === null) throw new Error(`The file "${file.name}" is not on any volume we can read`);
  const library = await libraries.findById(ref.libraryId);
  if (library === null || library.deletedAt !== null) {
    throw new Error(`The file "${file.name}" is in a library that no longer exists`);
  }
  return reader.openStream(
    { rootPath: library.rootPath, excludeGlobs: library.excludeGlobs },
    ref.path,
  );
}
