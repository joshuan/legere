import type { File } from '../../domain/entities/file';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { BinarySource } from '../ports/binary-source';

export class DocumentMarkdownSource {
  constructor(
    private readonly files: FileRepository,
    private readonly read: (file: File) => Promise<BinarySource>,
  ) {}

  async open(documentId: string): Promise<BinarySource | null> {
    // Re-read after canonicalization expands the whole-file placeholder and records page counts.
    const pages = await this.files.listPagesForDocument(documentId);
    const first = pages[0];
    if (first === undefined) return null;
    const file = first.file;
    if (
      file.mimeType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.pageCount !== pages.length ||
      !pages.every(
        (page, index) =>
          page.fileId === file.id &&
          page.position === index &&
          page.pageIndex === index &&
          page.crop === null &&
          page.turn === null,
      )
    ) {
      return null;
    }
    return this.read(file);
  }
}
