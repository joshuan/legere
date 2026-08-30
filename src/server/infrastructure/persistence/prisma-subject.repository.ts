import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Subject } from '../../domain/entities/subject';
import { foldName } from '../../domain/value-objects/name-fold';
import {
  SubjectRepository,
  type SubjectWithCount,
} from '../../domain/repositories/subject.repository';
import { decodeTextCursor, encodeTextCursor } from './cursor';
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

  async listPage(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: SubjectWithCount[]; nextCursor: string | null }> {
    // Keyset over (name, id), the shape every other list uses (docs/07 §7.1).
    const cursor = decodeTextCursor(query.cursor);
    const rows = await this.prisma.subject.findMany({
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
      include: { kind: true, _count: { select: { documents: true } } },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({ ...toSubject(row), documentCount: row._count.documents })),
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeTextCursor({ key: last.name, id: last.id })
          : null,
    };
  }

  countActive(tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).subject.count({ where: { deletedAt: null } });
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Subject | null> {
    const row = await clientOf(this.prisma, tx).subject.findFirst({
      where: { id, deletedAt: null },
      include: { kind: true },
    });
    return row === null ? null : toSubject(row);
  }

  async findByIds(ids: string[], tx?: TransactionHandle): Promise<Subject[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).subject.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: { kind: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(toSubject);
  }

  async findByKindAndName(
    kindId: string,
    name: string,
    tx?: TransactionHandle,
  ): Promise<Subject | null> {
    const row = await clientOf(this.prisma, tx).subject.findFirst({
      // 🔒 The fold, not ILIKE: the same flat in another case is the same flat
      // (docs/03 §3.3.20).
      where: {
        kindId,
        nameFolded: foldName(name),
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
        nameFolded: foldName(input.name),
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
        ...(input.name === undefined
          ? {}
          : { name: input.name.trim(), nameFolded: foldName(input.name) }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
      include: { kind: true },
    });
    return toSubject(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).subject.update({ where: { id }, data: { deletedAt } });
  }

  async listByKinds(kindIds: string[], tx?: TransactionHandle): Promise<Subject[]> {
    if (kindIds.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).subject.findMany({
      where: { kindId: { in: kindIds }, deletedAt: null },
      include: { kind: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(toSubject);
  }

  async moveToKind(ids: string[], kindId: string, tx?: TransactionHandle): Promise<void> {
    if (ids.length === 0) return;
    await clientOf(this.prisma, tx).subject.updateMany({
      where: { id: { in: ids } },
      data: { kindId },
    });
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
