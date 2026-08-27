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

// 🔒 How many documents one statement of the cascade below rewrites (docs/07 §7.3). The size of the
// cascade is not the admin's to choose: it is however many documents ordinary users filed under this
// type, and it grows without limit. Five hundred keeps each statement well inside the default
// interactive-transaction ceiling on the slowest disk this is meant to run on, and a hundred
// thousand documents is two hundred of them.
const RESET_BATCH = 500;

// DELETE /api/admin/document-types/:id: an application-level cascade and then a soft delete — the
// documents that carried it are reset to NONE first, or a deleted documentType would leave documents
// pointing at something that no longer exists (docs/03 §3.3.12).
export class DeleteDocumentType {
  constructor(
    private readonly documentTypes: DocumentTypeRepository,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<{ ok: true; documentsReset: number }> {
    const documentType = await this.documentTypes.findById(id);
    if (documentType === null)
      throw new NotFoundError('DOCUMENT_TYPE_NOT_FOUND', 'DocumentType not found');

    // 🔒 In batches and outside one transaction, because a single `updateMany` over every document
    // that carried the type could not finish. Each of those rows is non-HOT — `type_id` carries a
    // btree — so it writes a new tuple into every index it has, the GIN over its whole Markdown
    // included, and past a few thousand documents Prisma's five-second interactive-transaction
    // ceiling ended the request with an untyped `500` and a type that could not be deleted at all.
    //
    // The reset comes first and the soft delete last, so that an interruption leaves the type alive
    // over a partly-cleared set rather than a set pointing at a type nobody can see. Repeating the
    // request finishes the job: clearing a type from a document that no longer carries it is a
    // no-op, and the count is of what this call actually rewrote.
    let documentsReset = 0;
    for (;;) {
      const cleared = await this.documentTypes.clearTypeFromDocuments(id, RESET_BATCH);
      documentsReset += cleared;
      if (cleared < RESET_BATCH) break;
    }
    await this.documentTypes.softDelete(id, this.clock.now());

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
