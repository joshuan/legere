import type {
  ArchiveDocumentsQuery,
  ArchiveDocumentDto,
} from '../../../shared/contracts/archive-integration';
import type {
  PersonalArchiveDocument,
  PersonalArchiveRepository,
} from '../../domain/repositories/personal-archive.repository';
import { isProcessing } from '../../domain/entities/document';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { FileStorage } from '../ports/file-storage';
import type { Clock } from '../ports/clock';
import { artifactKeys } from '../storage/artifact-keys';

export class PersonalArchive {
  constructor(
    private readonly documents: PersonalArchiveRepository,
    private readonly storage: FileStorage,
    private readonly clock: Clock,
    private readonly baseUrl: string,
    private readonly ttlSec: number,
  ) {}
  async list(subject: string, query: ArchiveDocumentsQuery) {
    const page = await this.documents.list(subject, query);
    return { items: page.items.map((row) => this.dto(row)), nextCursor: page.nextCursor };
  }
  async get(subject: string, id: string) {
    return this.dto(await this.read(subject, id));
  }
  async artifact(subject: string, id: string, kind: 'canonical' | 'preview') {
    const document = await this.read(subject, id);
    if (document.steps[kind] !== 'DONE')
      throw new ConflictError(
        kind === 'canonical' ? 'CANONICAL_NOT_READY' : 'DOCUMENT_UNAVAILABLE',
        'The requested artifact is not ready',
      );
    const contentType =
      kind === 'canonical' ? ('application/pdf' as const) : ('image/jpeg' as const);
    const url = await this.storage.getSignedUrl(
      kind === 'canonical' ? artifactKeys.canonicalPdf(id) : artifactKeys.preview(id),
      this.ttlSec,
      { disposition: 'inline', contentType },
    );
    return {
      url,
      contentType,
      expiresAt: new Date(this.clock.now().getTime() + this.ttlSec * 1000).toISOString(),
    };
  }
  private async read(subject: string, id: string) {
    const document = await this.documents.find(subject, id);
    if (document === null) throw new NotFoundError('DOCUMENT_NOT_FOUND');
    return document;
  }
  private dto(document: PersonalArchiveDocument): ArchiveDocumentDto {
    return {
      ...document,
      processing: isProcessing(document.steps),
      url: `${this.baseUrl.replace(/\/+$/, '')}/documents/${document.id}`,
    };
  }
}
