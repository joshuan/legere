import type { TransactionHandle } from '../../application/ports/unit-of-work';

// Category entity (docs/03 §3.3.12): the admin-managed reference list the classifier chooses from.
export type Category = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type CreateCategoryInput = {
  slug: string;
  name: string;
  description: string | null;
};

export type UpdateCategoryInput = {
  name?: string;
  description?: string | null;
};

export type CategoryWithCount = Category & {
  documentCount: number;
};

export abstract class CategoryRepository {
  // Active categories, by slug: the list offered to the classifier and shown in the UI.
  abstract listActive(tx?: TransactionHandle): Promise<Category[]>;

  // The admin table (docs/11 §11.12): by name, with how many documents carry each one.
  abstract listActiveWithCounts(tx?: TransactionHandle): Promise<CategoryWithCount[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<Category | null>;

  abstract findActiveBySlug(slug: string, tx?: TransactionHandle): Promise<Category | null>;

  abstract create(input: CreateCategoryInput, tx?: TransactionHandle): Promise<Category>;

  abstract update(
    id: string,
    input: UpdateCategoryInput,
    tx?: TransactionHandle,
  ): Promise<Category>;

  // Soft delete (ADR-015). The documents that carried it are reset to NONE in the same
  // transaction — an application-level cascade (docs/03 §3.3.12).
  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  abstract clearCategoryFromDocuments(categoryId: string, tx?: TransactionHandle): Promise<number>;
}
