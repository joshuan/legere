import type { Readable } from 'node:stream';
import { ConflictError } from '../../domain/errors/domain-error';
import type { File } from '../../domain/entities/file';
import type { FileRefView } from '../../domain/repositories/file.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import type { Clock } from '../ports/clock';
import type { FileStorage } from '../ports/file-storage';
import type { LibraryReader } from '../ports/library-reader';
import { originalKeyOf } from '../storage/artifact-keys';

// Enough of a file to find its bytes: which storage holds them, and — for a volume — where the file
// was seen. A file of a document and one in the trash both answer this, so both can be opened.
type ReadableFile = Pick<File, 'id' | 'ext' | 'origin' | 'storageKey'> & {
  refs: readonly FileRefView[];
};

// The original bytes of one file, wherever they live (docs/09 §9.1–9.2): on the read-only volume, or
// in our own bucket. Everything that needs to *read* a file — the download of one original, the
// corner detector — asks here, so the two homes are told apart in one place.
export class DocumentFileBytes {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly reader: LibraryReader,
    private readonly storage: FileStorage,
    private readonly clock: Clock,
  ) {}

  async open(file: ReadableFile): Promise<Readable> {
    if (file.origin === 'MANAGED') return this.storage.getStream(originalKeyOf(file));

    // The first live home of these bytes among the ones this caller may see — the refs on the view
    // are already filtered to the libraries they were granted (docs/09 §9.1).
    //
    // `EXCLUDED` counts as a home here and nowhere else: it means the path is one Legere will not
    // *ingest* again (docs/03 §3.3.9), not that the bytes went away — and the trash screen exists to
    // hand those bytes back (docs/05 §5.7a). A file of a live document never carries one.
    const ref = file.refs.find(
      (candidate) => candidate.status === 'HASHED' || candidate.status === 'EXCLUDED',
    );
    if (ref === undefined) throw unavailable();

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) throw unavailable();

    const path = RelativePath.tryParse(ref.path);
    if (path === null) throw unavailable();

    return this.reader
      .openStream({ rootPath: library.rootPath, excludeGlobs: library.excludeGlobs }, path)
      .catch(async (error: unknown) => {
        // The file went away between the scan and this request. Recording it keeps the next listing
        // honest instead of offering a download that fails again (docs/09 §9.1).
        await this.markMissing(ref.libraryId, path);
        throw new ConflictError(
          'DOCUMENT_UNAVAILABLE',
          `The file is no longer on the volume: ${error instanceof Error ? error.message : ''}`,
        );
      });
  }

  private async markMissing(libraryId: string, path: RelativePath): Promise<void> {
    const ref = await this.fileRefs.findByPath(libraryId, path);
    if (ref === null) return;
    await this.fileRefs.markMissing([ref.id], this.clock.now());
  }
}

function unavailable(): ConflictError {
  return new ConflictError('DOCUMENT_UNAVAILABLE', 'These bytes are not on any volume we can read');
}
