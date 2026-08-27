import type { TransactionHandle } from '../../application/ports/unit-of-work';

// DocumentType entity (docs/03 §3.3.12): the admin-managed reference list the classifier chooses from.
export type DocumentType = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type CreateDocumentTypeInput = {
  slug: string;
  name: string;
  description: string | null;
};

export type UpdateDocumentTypeInput = {
  name?: string;
  description?: string | null;
};

export type DocumentTypeWithCount = DocumentType & {
  documentCount: number;
};

export abstract class DocumentTypeRepository {
  // Active documentTypes, by slug: the list offered to the classifier and shown in the UI.
  abstract listActive(tx?: TransactionHandle): Promise<DocumentType[]>;

  // The admin table (docs/11 §11.12): by name, with how many documents carry each one.
  abstract listActiveWithCounts(tx?: TransactionHandle): Promise<DocumentTypeWithCount[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<DocumentType | null>;

  abstract findActiveBySlug(slug: string, tx?: TransactionHandle): Promise<DocumentType | null>;

  abstract create(input: CreateDocumentTypeInput, tx?: TransactionHandle): Promise<DocumentType>;

  abstract update(
    id: string,
    input: UpdateDocumentTypeInput,
    tx?: TransactionHandle,
  ): Promise<DocumentType>;

  // Soft delete (ADR-015). The documents that carried it are reset to NONE first — an
  // application-level cascade, run in bounded batches rather than in one transaction with this
  // (docs/03 §3.3.12, docs/07 §7.3).
  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // 🔒 At most `limit` documents, and the count of the ones it actually cleared, so the caller can
  // keep going until there are none left. Bounded because the size of this cascade is decided by how
  // many documents ordinary users happened to file under one type: each row carries a `type_id`
  // btree, so the update cannot be HOT and writes a new tuple into every index of the row —
  // including the GIN over the whole of its Markdown. Past a few thousand of them, one `updateMany`
  // inside Prisma's default five-second interactive transaction times out with `P2028`, which is
  // neither a `DomainError` nor an `HttpException`: the admin gets `500 INTERNAL`, the type cannot
  // be deleted at all, and docs/07 §7.3 says it can.
  abstract clearTypeFromDocuments(
    typeId: string,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<number>;
}
