import { Injectable } from '@nestjs/common';
import type { DocumentType as PrismaCategory } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  DocumentTypeRepository,
  type DocumentType,
  type DocumentTypeWithCount,
  type CreateDocumentTypeInput,
  type UpdateDocumentTypeInput,
} from '../../domain/repositories/document-type.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaCategory): DocumentType {
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
export class PrismaCategoryRepository implements DocumentTypeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(tx?: TransactionHandle): Promise<DocumentType[]> {
    const rows = await clientOf(this.prisma, tx).documentType.findMany({
      where: { deletedAt: null },
      orderBy: { slug: 'asc' },
    });
    return rows.map(toDomain);
  }

  async listActiveWithCounts(tx?: TransactionHandle): Promise<DocumentTypeWithCount[]> {
    const rows = await clientOf(this.prisma, tx).documentType.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { documents: { where: { deletedAt: null } } } } },
    });
    return rows.map((row) => ({ ...toDomain(row), documentCount: row._count.documents }));
  }

  async findById(id: string, tx?: TransactionHandle): Promise<DocumentType | null> {
    const row = await clientOf(this.prisma, tx).documentType.findFirst({
      where: { id, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async findActiveBySlug(slug: string, tx?: TransactionHandle): Promise<DocumentType | null> {
    const row = await clientOf(this.prisma, tx).documentType.findFirst({
      where: { slug, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async create(input: CreateDocumentTypeInput, tx?: TransactionHandle): Promise<DocumentType> {
    const row = await clientOf(this.prisma, tx).documentType.create({
      data: { slug: input.slug, name: input.name, description: input.description },
    });
    return toDomain(row);
  }

  async update(
    id: string,
    input: UpdateDocumentTypeInput,
    tx?: TransactionHandle,
  ): Promise<DocumentType> {
    const row = await clientOf(this.prisma, tx).documentType.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
    return toDomain(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).documentType.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }

  // Both AUTO and MANUAL assignments go: the documentType no longer exists, so neither claim is true
  // any more (docs/03 §3.3.12).
  async clearCategoryFromDocuments(typeId: string, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).document.updateMany({
      where: { typeId },
      data: { typeId: null, typeSource: 'NONE' },
    });
    return result.count;
  }
}
