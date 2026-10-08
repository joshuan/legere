import type { File } from '../../domain/entities/file';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { EmailParser, EmailDocument } from '../ports/email-parser';
import type { BinarySource } from '../ports/binary-source';

export class DocumentMarkdownSource {
  constructor(
    private readonly files: FileRepository,
    private readonly read: (file: File) => Promise<BinarySource>,
    private readonly emails?: EmailParser,
  ) {}

  async open(documentId: string): Promise<BinarySource | null> {
    const file = await this.completeFile(
      documentId,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    return file === null ? null : this.read(file);
  }

  async openEmail(documentId: string): Promise<EmailDocument | null> {
    const file = await this.completeFile(documentId, 'message/rfc822');
    return file === null || this.emails === undefined
      ? null
      : this.emails.parse(await this.read(file));
  }

  private async completeFile(documentId: string, mime: string): Promise<File | null> {
    // Re-read after canonicalization expands the whole-file placeholder and records page counts.
    const pages = await this.files.listPagesForDocument(documentId);
    const first = pages[0];
    if (first === undefined) return null;
    const file = first.file;
    if (
      file.mimeType !== mime ||
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
    return file;
  }
}
