import type { IntegrationDocumentDto } from '../../../shared/contracts/integrations';
import { isProcessing, type Document } from '../../domain/entities/document';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type { FileStorage } from '../ports/file-storage';
import type { Clock } from '../ports/clock';
import { artifactKeys, canonicalKeyOf } from '../storage/artifact-keys';
import type { UploadDocument } from '../documents/upload-document';
import type { UploadedFile } from '../documents/compose-document';

export class IntegrationDocuments {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly upload: UploadDocument,
    private readonly storage: FileStorage,
    private readonly clock: Clock,
    private readonly baseUrl: string,
    private readonly ttlSec: number,
  ) {}

  async create(viewer: Viewer, input: UploadedFile) {
    this.assertIntegration(viewer);
    const result = await this.upload.execute(viewer, input);
    return { document: await this.get(viewer, result.document.id), created: result.created };
  }
  async list(viewer: Viewer, query: { limit: number; cursor?: string | undefined }) {
    this.assertIntegration(viewer);
    const page = await this.documents.listReadable(viewer, { ...query, sort: 'createdAt' });
    return {
      items: page.items.map((item) => this.dto(item.document)),
      nextCursor: page.nextCursor,
    };
  }
  async get(viewer: Viewer, id: string): Promise<IntegrationDocumentDto> {
    return this.dto(await this.read(viewer, id));
  }
  async artifact(viewer: Viewer, id: string, kind: 'canonical' | 'preview') {
    const document = await this.read(viewer, id);
    if (document.steps[kind] !== 'DONE') {
      throw new ConflictError(
        kind === 'canonical' ? 'CANONICAL_NOT_READY' : 'DOCUMENT_UNAVAILABLE',
        'The requested artifact is not ready',
      );
    }
    const contentType =
      kind === 'canonical' ? ('application/pdf' as const) : ('image/jpeg' as const);
    const url = await this.storage.getSignedUrl(
      kind === 'canonical' ? canonicalKeyOf(document) : artifactKeys.preview(id),
      this.ttlSec,
      { disposition: 'inline', contentType },
    );
    return {
      url,
      contentType,
      expiresAt: new Date(this.clock.now().getTime() + this.ttlSec * 1000).toISOString(),
    };
  }
  private async read(viewer: Viewer, id: string) {
    this.assertIntegration(viewer);
    const detail = await this.documents.findReadableById(id, viewer);
    if (detail === null) throw new NotFoundError('DOCUMENT_NOT_FOUND');
    return detail.document;
  }
  private assertIntegration(viewer: Viewer): void {
    if (viewer.integrationId === undefined)
      throw new Error('Integration document access needs a namespace');
  }
  private dto(document: Document): IntegrationDocumentDto {
    if (document.createdById === null) throw new Error('Integration document has no owner');
    return {
      id: document.id,
      title: document.title,
      description: document.description,
      documentDate: document.documentDate,
      pageCount: document.pageCount,
      createdAt: document.createdAt.toISOString(),
      processing: isProcessing(document.steps),
      steps: document.steps,
      url: `${this.baseUrl}/documents/${document.id}`,
      ownerId: document.createdById,
      createdVia: document.createdVia ?? null,
    };
  }
}
