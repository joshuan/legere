import { Injectable } from '@nestjs/common';
import type { Category as PrismaCategory } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { CategoryRepository, type Category } from '../../domain/repositories/category.repository';
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
}
