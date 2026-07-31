import type { BrowseQuery, BrowseResponse } from '../../../shared/contracts/libraries';
import { isLibraryVisibleTo } from '../../domain/entities/library';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { toListDto } from '../documents/manage-documents';

// GET /api/libraries/:id/browse (docs/07 §7.3, docs/11 §11.4): the mounted folder structure, at any
// nesting, reconstructed from the paths the scan recorded. Nothing here is stored as a tree.
export class BrowseLibrary {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly documents: DocumentRepository,
  ) {}

  async execute(viewer: Viewer, libraryId: string, query: BrowseQuery): Promise<BrowseResponse> {
    const library = await this.libraries.findById(libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new NotFoundError('LIBRARY_NOT_FOUND', 'Library not found');
    }

    // 🔒 A library the caller cannot see does not exist as far as they are concerned (docs/08 §8.5).
    if (viewer.role !== 'ADMIN') {
      const granted = await this.libraries.listVisibleTo(viewer.id);
      if (!isLibraryVisibleTo(library, new Set(granted.map((entry) => entry.id)))) {
        throw new NotFoundError('LIBRARY_NOT_FOUND', 'Library not found');
      }
    }

    // The path is validated as a relative path before it is used to match anything — traversal is
    // meaningless here, but a `..` in a prefix would still be a lie about where the caller is.
    const folder = RelativePath.tryParse(query.path);
    if (folder === null) throw new NotFoundError('LIBRARY_NOT_FOUND', 'Folder not found');

    const [folders, documents] = await Promise.all([
      this.fileRefs.listFoldersUnder(libraryId, folder.value),
      // No extra access clause: the caller was just checked against the library, and everything in
      // it is readable to them by definition (docs/03 §3.4).
      this.documents.listInFolder(libraryId, folder.value, {
        limit: query.limit,
        cursor: query.cursor,
      }),
    ]);

    return {
      path: folder.value,
      folders,
      documents: { items: documents.items.map(toListDto), nextCursor: documents.nextCursor },
    };
  }
}
