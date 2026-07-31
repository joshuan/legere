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

export abstract class CategoryRepository {
  // Active categories, by slug: the list offered to the classifier and shown in the UI.
  abstract listActive(tx?: TransactionHandle): Promise<Category[]>;
}
