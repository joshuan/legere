import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { SubjectKind } from '../../domain/entities/subject-kind';
import { foldName } from '../../domain/value-objects/name-fold';
import {
  SubjectKindRepository,
  type SubjectKindWithCounts,
} from '../../domain/repositories/subject-kind.repository';
import { decodeTextCursor, encodeTextCursor } from './cursor';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type SubjectKindRow = {
  id: string;
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

function toSubjectKind(row: SubjectKindRow): SubjectKind {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class PrismaSubjectKindRepository extends SubjectKindRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listActive(tx?: TransactionHandle): Promise<SubjectKindWithCounts[]> {
    const rows = await clientOf(this.prisma, tx).subjectKind.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        // Only the living subjects and their links: a soft-deleted subject is not something this
        // kind still holds (ADR-015).
        subjects: {
          where: { deletedAt: null },
          select: { _count: { select: { documents: true } } },
        },
      },
    });
    return rows.map((row) => ({
      ...toSubjectKind(row),
      subjectCount: row.subjects.length,
      documentCount: row.subjects.reduce((total, subject) => total + subject._count.documents, 0),
    }));
  }

  async listPage(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: SubjectKindWithCounts[]; nextCursor: string | null }> {
    // Keyset over (name, id), the shape every other list uses (docs/07 §7.1).
    const cursor = decodeTextCursor(query.cursor);
    const rows = await this.prisma.subjectKind.findMany({
      where: {
        deletedAt: null,
        ...(cursor === null
          ? {}
          : {
              OR: [{ name: { gt: cursor.key } }, { name: cursor.key, id: { gt: cursor.id } }],
            }),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      include: {
        subjects: {
          where: { deletedAt: null },
          include: { _count: { select: { documents: true } } },
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        ...toSubjectKind(row),
        subjectCount: row.subjects.length,
        documentCount: row.subjects.reduce((total, subject) => total + subject._count.documents, 0),
      })),
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeTextCursor({ key: last.name, id: last.id })
          : null,
    };
  }

  countActive(tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).subjectKind.count({ where: { deletedAt: null } });
  }

  async findById(id: string, tx?: TransactionHandle): Promise<SubjectKind | null> {
    const row = await clientOf(this.prisma, tx).subjectKind.findFirst({
      where: { id, deletedAt: null },
    });
    return row === null ? null : toSubjectKind(row);
  }

  async findByIds(ids: string[], tx?: TransactionHandle): Promise<SubjectKind[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).subjectKind.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toSubjectKind);
  }

  async findByName(name: string, tx?: TransactionHandle): Promise<SubjectKind | null> {
    const row = await clientOf(this.prisma, tx).subjectKind.findFirst({
      // 🔒 The fold, not ILIKE: Жильё must find жильё (docs/03 §3.3.19).
      where: { nameFolded: foldName(name), deletedAt: null },
    });
    return row === null ? null : toSubjectKind(row);
  }

  async create(
    input: { name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<SubjectKind> {
    const row = await clientOf(this.prisma, tx).subjectKind.create({
      // As typed: the case is the owner's, and only the uniqueness check ignores it
      // (docs/03 §3.3.20a).
      data: { name: input.name.trim(), nameFolded: foldName(input.name), note: input.note ?? null },
    });
    return toSubjectKind(row);
  }

  async update(
    id: string,
    input: { name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<SubjectKind> {
    const row = await clientOf(this.prisma, tx).subjectKind.update({
      where: { id },
      data: {
        ...(input.name === undefined
          ? {}
          : { name: input.name.trim(), nameFolded: foldName(input.name) }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    return toSubjectKind(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).subjectKind.update({ where: { id }, data: { deletedAt } });
  }

  countLivingSubjects(id: string, tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).subject.count({ where: { kindId: id, deletedAt: null } });
  }
}
