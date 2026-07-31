import { Injectable } from '@nestjs/common';
import type { Category as PrismaCategory } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  CategoryRepository,
  type Category,
  type CategoryWithCount,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from '../../domain/repositories/category.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaCategory): Category {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class PrismaCategoryRepository implements CategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(tx?: TransactionHandle): Promise<Category[]> {
    const rows = await clientOf(this.prisma, tx).category.findMany({
      where: { deletedAt: null },
      orderBy: { slug: 'asc' },
    });
    return rows.map(toDomain);
  }

  async listActiveWithCounts(tx?: TransactionHandle): Promise<CategoryWithCount[]> {
    const rows = await clientOf(this.prisma, tx).category.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { documents: { where: { deletedAt: null } } } } },
    });
    return rows.map((row) => ({ ...toDomain(row), documentCount: row._count.documents }));
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Category | null> {
    const row = await clientOf(this.prisma, tx).category.findFirst({
      where: { id, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async findActiveBySlug(slug: string, tx?: TransactionHandle): Promise<Category | null> {
    const row = await clientOf(this.prisma, tx).category.findFirst({
      where: { slug, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async create(input: CreateCategoryInput, tx?: TransactionHandle): Promise<Category> {
    const row = await clientOf(this.prisma, tx).category.create({
      data: { slug: input.slug, name: input.name, description: input.description },
    });
    return toDomain(row);
  }

  async update(id: string, input: UpdateCategoryInput, tx?: TransactionHandle): Promise<Category> {
    const row = await clientOf(this.prisma, tx).category.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
    return toDomain(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).category.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }

  // Both AUTO and MANUAL assignments go: the category no longer exists, so neither claim is true
  // any more (docs/03 §3.3.12).
  async clearCategoryFromDocuments(categoryId: string, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).document.updateMany({
      where: { categoryId },
      data: { categoryId: null, categorySource: 'NONE' },
    });
    return result.count;
  }
}
