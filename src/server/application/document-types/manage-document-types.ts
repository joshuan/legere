import type {
  DocumentTypeDto,
  CreateDocumentTypeRequest,
  ListDocumentTypesResponse,
  UpdateDocumentTypeRequest,
} from '../../../shared/contracts/document-types';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type {
  DocumentType,
  DocumentTypeRepository,
} from '../../domain/repositories/document-type.repository';
import type { Clock } from '../ports/clock';
import type { UnitOfWork } from '../ports/unit-of-work';

// GET /api/document-types (docs/07 §7.3): the reference list, for filters and the documentType picker. Every
// signed-in user reads it; only an admin changes it.
export class ListDocumentTypes {
  constructor(private readonly documentTypes: DocumentTypeRepository) {}

  async execute(): Promise<ListDocumentTypesResponse> {
    const rows = await this.documentTypes.listActiveWithCounts();
    return { items: rows.map(toDto) };
  }
}

export class CreateDocumentType {
  constructor(private readonly documentTypes: DocumentTypeRepository) {}

  async execute(input: CreateDocumentTypeRequest): Promise<DocumentTypeDto> {
    const existing = await this.documentTypes.findActiveBySlug(input.slug);
    if (existing !== null) {
      throw new ConflictError(
        'DOCUMENT_TYPE_SLUG_TAKEN',
        'A documentType with this slug already exists',
      );
    }

    const created = await this.documentTypes.create({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
    });
    return toDto({ ...created, documentCount: 0 });
  }
}

// PATCH /api/admin/document-types/:id: name and description only. 🔒 The slug is immutable — documents
// do not store it, but the classifier answers with it and users bookmark filters by it, so changing
// it would quietly rewrite what those mean (docs/07 §7.3).
export class UpdateDocumentType {
  constructor(private readonly documentTypes: DocumentTypeRepository) {}

  async execute(id: string, input: UpdateDocumentTypeRequest): Promise<DocumentTypeDto> {
    const documentType = await this.documentTypes.findById(id);
    if (documentType === null)
      throw new NotFoundError('DOCUMENT_TYPE_NOT_FOUND', 'DocumentType not found');

    const updated = await this.documentTypes.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });

    const counts = await this.documentTypes.listActiveWithCounts();
    const withCount = counts.find((candidate) => candidate.id === updated.id);
    return toDto({ ...updated, documentCount: withCount?.documentCount ?? 0 });
  }
}

// DELETE /api/admin/document-types/:id: soft delete plus an application-level cascade — the documents
// that carried it are reset to NONE in the same transaction, or a deleted documentType would leave
// documents pointing at something that no longer exists (docs/03 §3.3.12).
export class DeleteDocumentType {
  constructor(
    private readonly documentTypes: DocumentTypeRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<{ ok: true; documentsReset: number }> {
    const documentType = await this.documentTypes.findById(id);
    if (documentType === null)
      throw new NotFoundError('DOCUMENT_TYPE_NOT_FOUND', 'DocumentType not found');

    const documentsReset = await this.unitOfWork.run(async (tx) => {
      const reset = await this.documentTypes.clearCategoryFromDocuments(id, tx);
      await this.documentTypes.softDelete(id, this.clock.now(), tx);
      return reset;
    });

    return { ok: true, documentsReset };
  }
}

function toDto(documentType: DocumentType & { documentCount: number }): DocumentTypeDto {
  return {
    id: documentType.id,
    slug: documentType.slug,
    name: documentType.name,
    description: documentType.description,
    documentCount: documentType.documentCount,
  };
}
