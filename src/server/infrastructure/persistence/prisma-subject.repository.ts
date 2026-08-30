import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Subject } from '../../domain/entities/subject';
import { ConflictError } from '../../domain/errors/domain-error';
import { foldName } from '../../domain/value-objects/name-fold';
import type {
  CataloguePage,
  CataloguePageQuery,
} from '../../domain/repositories/person.repository';
import {
  SubjectRepository,
  type SubjectListRow,
  type SubjectWithCount,
} from '../../domain/repositories/subject.repository';
import {
  catalogueCursorKeyOf,
  catalogueKeysetSql,
  catalogueOrderBySql,
} from './catalogue-list-sql';
import { decodeCatalogueCursor, encodeCatalogueCursor } from './cursor';
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

// What the list SQL answers per row (docs/07 §7.3): the living row with its kind, its count of
// living documents, and the newest `documentDate` among them. Deleted rows never reach the page,
// so `deletedAt` is null by construction.
type SubjectPageRow = {
  id: string;
  kindId: string;
  kind: string;
  name: string;
  note: string | null;
  createdAt: Date;
  documentCount: number;
  lastDocumentAt: Date | null;
};

function toSubjectListRow(row: SubjectPageRow): SubjectListRow {
  return {
    id: row.id,
    kindId: row.kindId,
    kind: row.kind,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: null,
    documentCount: row.documentCount,
    lastDocumentAt: row.lastDocumentAt,
  };
}

// P2002 here can only come from subjects_kind_name_folded_uq: two writers raced the application's
// uniqueness check and the index picked a winner (docs/04 §4.3).
function asSubjectExists(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictError('SUBJECT_EXISTS', 'This thing is already in the list');
  }
  return error;
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

  async listPage(query: CataloguePageQuery): Promise<CataloguePage<SubjectListRow>> {
    // Keyset in the asked-for order, on the people repository's terms (docs/07 §7.3): raw SQL
    // because two of the named orders are aggregates no object orderBy can keyset over.
    const cursor = decodeCatalogueCursor(query.cursor, query.sort, query.order);
    const rows = await this.prisma.$queryRaw<SubjectPageRow[]>`
      WITH page AS (
        SELECT s.id, s.kind_id AS "kindId", k.name AS kind, s.name, s.note,
               s.created_at AS "createdAt",
               count(d.id)::int AS "documentCount",
               max(d.document_date) AS "lastDocumentAt"
        FROM subjects s
        JOIN subject_kinds k ON k.id = s.kind_id
        LEFT JOIN document_subjects ds ON ds.subject_id = s.id
        LEFT JOIN documents d ON d.id = ds.document_id AND d.deleted_at IS NULL
        WHERE s.deleted_at IS NULL
        GROUP BY s.id, k.name
      )
      SELECT * FROM page
      WHERE ${catalogueKeysetSql(cursor)}
      ORDER BY ${catalogueOrderBySql(query.sort, query.order)}
      LIMIT ${query.limit + 1}
    `;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toSubjectListRow),
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCatalogueCursor({
              sort: query.sort,
              order: query.order,
              key: catalogueCursorKeyOf(query.sort, toSubjectListRow(last)),
              id: last.id,
            })
          : null,
    };
  }

  async findListRow(id: string, tx?: TransactionHandle): Promise<SubjectListRow | null> {
    const rows = await clientOf(this.prisma, tx).$queryRaw<SubjectPageRow[]>`
      SELECT s.id, s.kind_id AS "kindId", k.name AS kind, s.name, s.note,
             s.created_at AS "createdAt",
             count(d.id)::int AS "documentCount",
             max(d.document_date) AS "lastDocumentAt"
      FROM subjects s
      JOIN subject_kinds k ON k.id = s.kind_id
      LEFT JOIN document_subjects ds ON ds.subject_id = s.id
      LEFT JOIN documents d ON d.id = ds.document_id AND d.deleted_at IS NULL
      WHERE s.deleted_at IS NULL AND s.id = ${id}::uuid
      GROUP BY s.id, k.name
    `;
    const row = rows[0];
    return row === undefined ? null : toSubjectListRow(row);
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
    try {
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
    } catch (error) {
      throw asSubjectExists(error);
    }
  }

  async update(
    id: string,
    input: { kindId?: string; name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject> {
    try {
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
    } catch (error) {
      throw asSubjectExists(error);
    }
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
