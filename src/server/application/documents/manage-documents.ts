import type {
  DocumentDetailDto,
  DocumentListDto,
  ListDocumentsQuery,
  ListDocumentsResponse,
  UpdateDocumentRequest,
} from '../../../shared/contracts/documents';
import { canEditDocumentMeta, isProcessing } from '../../domain/entities/document';
import { ForbiddenError, NotFoundError } from '../../domain/errors/domain-error';
import type { CategoryRepository } from '../../domain/repositories/category.repository';
import type {
  DocumentDetail,
  DocumentListItem,
  DocumentRepository,
  UpdateDocumentMetaInput,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { Clock } from '../ports/clock';

// GET /api/documents (docs/07 §7.3). The filter set is fixed and the access rule lives in the
// query, so a page of thirty is thirty documents this caller may actually read.
export class ListDocuments {
  constructor(private readonly documents: DocumentRepository) {}

  async execute(viewer: Viewer, query: ListDocumentsQuery): Promise<ListDocumentsResponse> {
    const page = await this.documents.listReadable(viewer, query);
    return { items: page.items.map(toListDto), nextCursor: page.nextCursor };
  }
}

// GET /api/documents/:id. The guard has already loaded the document; this only shapes it.
export class GetDocument {
  execute(detail: DocumentDetail): DocumentDetailDto {
    return toDetailDto(detail);
  }
}

// PATCH /api/documents/:id (docs/07 §7.3): title and category, per canEditDocumentMeta.
export class UpdateDocumentMeta {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly categories: CategoryRepository,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: UpdateDocumentRequest,
  ): Promise<DocumentDetailDto> {
    if (!canEditDocumentMeta(viewer, detail.document)) {
      throw new ForbiddenError('You may not edit this document');
    }

    const update: UpdateDocumentMetaInput = {};
    if (input.title !== undefined) update.title = input.title;

    if (input.categoryId !== undefined) {
      if (input.categoryId === null) {
        // Clearing a category is a decision too: it must not read as "never classified", or the
        // next pipeline run would put the old one straight back (docs/03 §3.3.10).
        update.categoryId = null;
        update.categorySource = 'NONE';
      } else {
        const categories = await this.categories.listActive();
        const chosen = categories.find((category) => category.id === input.categoryId);
        if (chosen === undefined) {
          throw new NotFoundError('CATEGORY_NOT_FOUND', 'Category not found');
        }
        update.categoryId = chosen.id;
        // 🔒 A person's choice is MANUAL, and the classifier never overwrites it (docs/05 §5.5).
        update.categorySource = 'MANUAL';
      }
    }

    const updated = await this.documents.updateMeta(detail.document.id, update);
    const category =
      update.categoryId === undefined
        ? detail.category
        : ((await this.categories.listActive()).find(
            (candidate) => candidate.id === updated.categoryId,
          ) ?? null);

    return toDetailDto({
      ...detail,
      document: updated,
      category:
        category === null ? null : { id: category.id, slug: category.slug, name: category.name },
    });
  }
}

// DELETE /api/documents/:id (admin): soft delete, after which every route stops finding it.
export class DeleteDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly clock: Clock,
  ) {}

  async execute(documentId: string): Promise<{ ok: true }> {
    const document = await this.documents.findById(documentId);
    if (document === null || document.deletedAt !== null) {
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }
    await this.documents.softDelete(documentId, this.clock.now());
    return { ok: true };
  }
}

export function toListDto(item: DocumentListItem): DocumentListDto {
  const { document } = item;
  return {
    id: document.id,
    title: document.title,
    ext: document.ext,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes.toString(),
    pageCount: document.pageCount,
    category: item.category,
    availability: item.availability,
    processing: isProcessing(document.steps),
    source: document.source,
    hasPreview: document.steps.preview === 'DONE',
    createdAt: document.createdAt.toISOString(),
  };
}

function toDetailDto(detail: DocumentDetail): DocumentDetailDto {
  const { document } = detail;
  return {
    ...toListDto(detail),
    contentHash: document.contentHash,
    ocrUsed: document.ocrUsed,
    categorySource: document.categorySource,
    steps: document.steps,
    skipReasons: document.skipReasons,
    processingError: document.processingError,
    failedStep: document.failedStep,
    fileRefs: detail.fileRefs,
    createdBy: detail.createdBy,
    scanSetId: document.scanSetId,
  };
}
