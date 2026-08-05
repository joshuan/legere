import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Subject } from '../../domain/entities/subject';
import {
  SubjectRepository,
  type SubjectWithCount,
} from '../../domain/repositories/subject.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type SubjectRow = {
  id: string;
  kindId: string;
  kind: { name: string };
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

function toSubject(row: SubjectRow): Subject {
  return {
    id: row.id,
    kindId: row.kindId,
    kind: row.kind.name,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class PrismaSubjectRepository extends SubjectRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listActive(tx?: TransactionHandle): Promise<SubjectWithCount[]> {
    const rows = await clientOf(this.prisma, tx).subject.findMany({
      where: { deletedAt: null },
      // Grouped by kind on screen, so grouped in the answer: the client should not have to sort a
      // catalogue to show it as one.
      orderBy: [{ kind: { name: 'asc' } }, { name: 'asc' }],
      include: { kind: true, _count: { select: { documents: true } } },
    });
    return rows.map((row) => ({ ...toSubject(row), documentCount: row._count.documents }));
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Subject | null> {
    const row = await clientOf(this.prisma, tx).subject.findFirst({
      where: { id, deletedAt: null },
      include: { kind: true },
    });
    return row === null ? null : toSubject(row);
  }

  async findByKindAndName(
    kindId: string,
    name: string,
    tx?: TransactionHandle,
  ): Promise<Subject | null> {
    const row = await clientOf(this.prisma, tx).subject.findFirst({
      where: {
        kindId,
        name: { equals: name.trim(), mode: 'insensitive' },
        deletedAt: null,
      },
      include: { kind: true },
    });
    return row === null ? null : toSubject(row);
  }

  async create(
    input: { kindId: string; name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject> {
    const row = await clientOf(this.prisma, tx).subject.create({
      data: {
        kindId: input.kindId,
        name: input.name.trim(),
        note: input.note ?? null,
      },
      include: { kind: true },
    });
    return toSubject(row);
  }

  async update(
    id: string,
    input: { kindId?: string; name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject> {
    const row = await clientOf(this.prisma, tx).subject.update({
      where: { id },
      data: {
        ...(input.kindId === undefined ? {} : { kindId: input.kindId }),
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      include: { kind: true },
    });
    return toSubject(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).subject.update({ where: { id }, data: { deletedAt } });
  }

  async listForDocument(documentId: string, tx?: TransactionHandle): Promise<Subject[]> {
    const rows = await clientOf(this.prisma, tx).documentSubject.findMany({
      where: { documentId, subject: { deletedAt: null } },
      include: { subject: { include: { kind: true } } },
      orderBy: [{ subject: { kind: { name: 'asc' } } }, { subject: { name: 'asc' } }],
    });
    return rows.map((row) => toSubject(row.subject));
  }

  async moveDocumentLinks(fromIds: string[], toId: string, tx?: TransactionHandle): Promise<void> {
    if (fromIds.length === 0) return;
    const client = clientOf(this.prisma, tx);

    // Create-then-delete, not an UPDATE: a document that was about two of the merged things would
    // collide on the primary key. `skipDuplicates` collapses it into the one link it should have.
    const links = await client.documentSubject.findMany({
      where: { subjectId: { in: fromIds } },
      select: { documentId: true },
    });
    if (links.length > 0) {
      await client.documentSubject.createMany({
        data: links.map((link) => ({ documentId: link.documentId, subjectId: toId })),
        skipDuplicates: true,
      });
    }
    await client.documentSubject.deleteMany({ where: { subjectId: { in: fromIds } } });
  }

  async setForDocument(
    documentId: string,
    subjectIds: string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.documentSubject.deleteMany({
      where: {
        documentId,
        ...(subjectIds.length === 0 ? {} : { subjectId: { notIn: subjectIds } }),
      },
    });
    if (subjectIds.length > 0) {
      await client.documentSubject.createMany({
        data: subjectIds.map((subjectId) => ({ documentId, subjectId })),
        skipDuplicates: true,
      });
    }
  }
}
