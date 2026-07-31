import type {
  CategoryDto,
  CreateCategoryRequest,
  ListCategoriesResponse,
  UpdateCategoryRequest,
} from '../../../shared/contracts/categories';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { Category, CategoryRepository } from '../../domain/repositories/category.repository';
import type { Clock } from '../ports/clock';
import type { UnitOfWork } from '../ports/unit-of-work';

// GET /api/categories (docs/07 §7.3): the reference list, for filters and the category picker. Every
// signed-in user reads it; only an admin changes it.
export class ListCategories {
  constructor(private readonly categories: CategoryRepository) {}

  async execute(): Promise<ListCategoriesResponse> {
    const rows = await this.categories.listActiveWithCounts();
    return { items: rows.map(toDto) };
  }
}

export class CreateCategory {
  constructor(private readonly categories: CategoryRepository) {}

  async execute(input: CreateCategoryRequest): Promise<CategoryDto> {
    const existing = await this.categories.findActiveBySlug(input.slug);
    if (existing !== null) {
      throw new ConflictError('CATEGORY_SLUG_TAKEN', 'A category with this slug already exists');
    }

    const created = await this.categories.create({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
    });
    return toDto({ ...created, documentCount: 0 });
  }
}

// PATCH /api/admin/categories/:id: name and description only. 🔒 The slug is immutable — documents
// do not store it, but the classifier answers with it and users bookmark filters by it, so changing
// it would quietly rewrite what those mean (docs/07 §7.3).
export class UpdateCategory {
  constructor(private readonly categories: CategoryRepository) {}

  async execute(id: string, input: UpdateCategoryRequest): Promise<CategoryDto> {
    const category = await this.categories.findById(id);
    if (category === null) throw new NotFoundError('CATEGORY_NOT_FOUND', 'Category not found');

    const updated = await this.categories.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
    });

    const counts = await this.categories.listActiveWithCounts();
    const withCount = counts.find((candidate) => candidate.id === updated.id);
    return toDto({ ...updated, documentCount: withCount?.documentCount ?? 0 });
  }
}

// DELETE /api/admin/categories/:id: soft delete plus an application-level cascade — the documents
// that carried it are reset to NONE in the same transaction, or a deleted category would leave
// documents pointing at something that no longer exists (docs/03 §3.3.12).
export class DeleteCategory {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<{ ok: true; documentsReset: number }> {
    const category = await this.categories.findById(id);
    if (category === null) throw new NotFoundError('CATEGORY_NOT_FOUND', 'Category not found');

    const documentsReset = await this.unitOfWork.run(async (tx) => {
      const reset = await this.categories.clearCategoryFromDocuments(id, tx);
      await this.categories.softDelete(id, this.clock.now(), tx);
      return reset;
    });

    return { ok: true, documentsReset };
  }
}

function toDto(category: Category & { documentCount: number }): CategoryDto {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    description: category.description,
    documentCount: category.documentCount,
  };
}
