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

  // Soft delete (ADR-015). The documents that carried it are reset to NONE in the same
  // transaction — an application-level cascade (docs/03 §3.3.12).
  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  abstract clearCategoryFromDocuments(typeId: string, tx?: TransactionHandle): Promise<number>;
}
