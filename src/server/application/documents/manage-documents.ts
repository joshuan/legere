import type {
  DocumentDetailDto,
  DocumentEventPage,
  DocumentListDto,
  ListDocumentsQuery,
  ListDocumentsResponse,
  UpdateDocumentRequest,
} from '../../../shared/contracts/documents';
import { canEditDocumentMeta, isProcessing, type Document } from '../../domain/entities/document';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import { ForbiddenError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
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

// PATCH /api/documents/:id (docs/07 §7.3): title and documentType, per canEditDocumentMeta.
// The history of one document (docs/03 §3.3.18). Access is the document's own: whoever may read it
// may read how it came to be what it is.
export class ListDocumentEvents {
  constructor(private readonly events: DocumentEventRepository) {}

  async execute(
    documentId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<DocumentEventPage> {
    const page = await this.events.listForDocument(documentId, query);
    return {
      items: page.items.map((event) => ({
        id: event.id,
        type: event.type,
        at: event.at.toISOString(),
        actor: event.actorName,
        payload: event.payload,
      })),
      nextCursor: page.nextCursor,
    };
  }
}

export class UpdateDocumentMeta {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly documentTypes: DocumentTypeRepository,
    private readonly events: DocumentEventRepository,
    private readonly people: PersonRepository,
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
    // Corrections a person makes by hand. The detector is a guess — it cannot tell Serbian from
    // Croatian in Latin script, and it knows nothing about where a document came from — so being
    // able to fix it is part of the feature, not an afterthought (docs/03 §3.3.10).
    if (input.languages !== undefined) update.languages = input.languages;
    if (input.country !== undefined) update.country = input.country;
    if (input.city !== undefined) update.city = input.city;

    if (input.typeId !== undefined) {
      if (input.typeId === null) {
        // Clearing a documentType is a decision too: it must not read as "never classified", or the
        // next pipeline run would put the old one straight back (docs/03 §3.3.10).
        update.typeId = null;
        update.typeSource = 'NONE';
      } else {
        const documentTypes = await this.documentTypes.listActive();
        const chosen = documentTypes.find((documentType) => documentType.id === input.typeId);
        if (chosen === undefined) {
          throw new NotFoundError('DOCUMENT_TYPE_NOT_FOUND', 'DocumentType not found');
        }
        update.typeId = chosen.id;
        // 🔒 A person's choice is MANUAL, and the classifier never overwrites it (docs/05 §5.5).
        update.typeSource = 'MANUAL';
      }
    }

    // Putting a field back to what the pipeline read. Applied after the explicit values so that a
    // reset always wins: a form can send both, and "put it back" is the later instruction.
    if (input.reset !== undefined) {
      const auto = detail.document.auto;
      for (const field of input.reset) {
        if (field === 'languages') update.languages = auto.languages ?? [];
        if (field === 'country') update.country = auto.country ?? null;
        if (field === 'city') update.city = auto.city ?? null;
        if (field === 'documentType') {
          const documentTypes = await this.documentTypes.listActive();
          const read = documentTypes.find((documentType) => documentType.slug === auto.typeSlug);
          update.typeId = read?.id ?? null;
          // 🔒 Back to AUTO, not MANUAL: the point of a reset is that the document stops claiming a
          // person chose this, so the next run may classify it again (docs/03 §3.3.10).
          update.typeSource = read === undefined ? 'NONE' : 'AUTO';
        }
      }
    }

    // People are a set, not a field on the row: sent whole, replaced whole (docs/03 §3.3.19).
    if (input.peopleIds !== undefined) {
      await this.people.setForDocument(detail.document.id, input.peopleIds);
    }

    const updated = await this.documents.updateMeta(detail.document.id, update);

    // What changed, and who changed it. The values are recorded from before and after rather than
    // from the request, so a reset reads as the value it restored (docs/03 §3.3.18).
    const changes = describeChanges(detail.document, updated);
    if (Object.keys(changes).length > 0) {
      await this.events.record({
        documentId: detail.document.id,
        type: 'META_CHANGED',
        actorId: viewer.id,
        payload: { changes },
      });
    }
    const documentType =
      update.typeId === undefined
        ? detail.documentType
        : ((await this.documentTypes.listActive()).find(
            (candidate) => candidate.id === updated.typeId,
          ) ?? null);

    return toDetailDto({
      ...detail,
      document: updated,
      documentType:
        documentType === null
          ? null
          : { id: documentType.id, slug: documentType.slug, name: documentType.name },
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
    documentType: item.documentType,
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
    typeSource: document.typeSource,
    steps: document.steps,
    skipReasons: document.skipReasons,
    languages: document.languages,
    auto: document.auto,
    people: detail.people,
    country: document.country,
    city: document.city,
    processingError: document.processingError,
    failedStep: document.failedStep,
    fileRefs: detail.fileRefs,
    createdBy: detail.createdBy,
    scanSetId: document.scanSetId,
  };
}

// Before and after, for the fields a person may edit. Only what actually moved: a log full of
// "title: Ticket → Ticket" is a log nobody reads (docs/03 §3.3.18).
function describeChanges(
  before: Document,
  after: Document,
): Record<string, { from?: string | null | undefined; to?: string | null | undefined }> {
  const changes: Record<string, { from?: string | null; to?: string | null }> = {};
  if (before.title !== after.title) changes.title = { from: before.title, to: after.title };
  if (before.typeId !== after.typeId) {
    changes.documentType = { from: before.typeId, to: after.typeId };
  }
  if (before.languages.join('|') !== after.languages.join('|')) {
    changes.languages = { from: before.languages.join(', '), to: after.languages.join(', ') };
  }
  if (before.country !== after.country)
    changes.country = { from: before.country, to: after.country };
  if (before.city !== after.city) changes.city = { from: before.city, to: after.city };
  return changes;
}
