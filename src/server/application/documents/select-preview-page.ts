import type { DocumentDetailDto, DocumentStep } from '../../../shared/contracts/documents';
import type { UpdateDocumentPreviewRequest } from '../../../shared/contracts/files';
import { classifyFormat } from '../../domain/entities/document-format';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type {
  DocumentDetail,
  DocumentRepository,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { JobQueue } from '../ports/job-queue';
import type { UnitOfWork } from '../ports/unit-of-work';
import { assertMayCompose, reload } from './compose-document';

export class SelectDocumentPreviewPage {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    { pageId }: UpdateDocumentPreviewRequest,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    await this.unitOfWork.run(async (tx) => {
      const pages = await this.files.lockPagesForDocument(documentId, tx);
      const current = await this.documents.findReadableById(documentId, viewer, tx);
      if (current === null) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
      assertMayCompose(viewer, current);
      if (pageId !== null) {
        const page = pages.find((entry) => entry.id === pageId);
        if (page === undefined)
          throw new NotFoundError('PAGE_NOT_FOUND', 'Page not found in this document');
        if (page.pageIndex === null || classifyFormat(page.file.mimeType) === 'UNSUPPORTED') {
          throw new ConflictError(
            'PREVIEW_PAGE_NOT_READY',
            'Build this page before selecting it for preview',
          );
        }
      }
      if (current.document.previewPageId === pageId) return;
      const steps: DocumentStep[] =
        current.document.canonicalPageIds.length === 0 ||
        (pageId !== null && !current.document.canonicalPageIds.includes(pageId))
          ? ['canonical', 'preview']
          : ['preview'];
      await this.documents.updateMeta(documentId, { previewPageId: pageId }, tx);
      await this.documents.updateProcessing(
        documentId,
        {
          steps: Object.fromEntries(steps.map((step) => [step, 'QUEUED'])),
        },
        tx,
      );
      const positionOf = (id: string | null): string | null => {
        const page = pages.find((entry) => entry.id === id);
        return page === undefined ? null : String(page.position + 1);
      };
      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            changes: {
              previewPage: {
                from: positionOf(current.document.previewPageId),
                to: positionOf(pageId),
              },
            },
          },
        },
        tx,
      );
      await this.queue.enqueueAfterTx(
        tx,
        'document-process',
        { documentId, steps },
        { priority: 10 },
      );
      await this.events.record(
        { documentId, type: 'QUEUED', actorId: viewer.id, payload: { steps } },
        tx,
      );
    });
    return reload(this.documents, viewer, documentId);
  }
}
