import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { SubjectKind } from '../../domain/entities/subject-kind';
import { ConflictError } from '../../domain/errors/domain-error';
import { foldName } from '../../domain/value-objects/name-fold';
import type { CataloguePage } from '../../domain/repositories/person.repository';
import {
  SubjectKindRepository,
  type SubjectKindListRow,
  type SubjectKindPageQuery,
  type SubjectKindWithCounts,
} from '../../domain/repositories/subject-kind.repository';
import {
  catalogueCursorKeyOf,
  catalogueKeysetSql,
  catalogueOrderBySql,
} from './catalogue-list-sql';
import { decodeCatalogueCursor, encodeCatalogueCursor } from './cursor';
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

// What the list SQL answers per row (docs/07 §7.3): the living kind, its two counts over living
// rows and living documents, and the newest `documentDate` across them. Deleted rows never reach
// the page, so `deletedAt` is null by construction.
type SubjectKindPageRow = {
  id: string;
  name: string;
  note: string | null;
  createdAt: Date;
  subjectCount: number;
  documentCount: number;
  lastDocumentAt: Date | null;
};

function toSubjectKindListRow(row: SubjectKindPageRow): SubjectKindListRow {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: null,
    subjectCount: row.subjectCount,
    documentCount: row.documentCount,
    lastDocumentAt: row.lastDocumentAt,
  };
}

// P2002 here can only come from subject_kinds_name_folded_uq: two writers raced the application's
// uniqueness check and the index picked a winner (docs/04 §4.3).
function asSubjectKindExists(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictError('SUBJECT_KIND_EXISTS', 'This kind is already in the list');
  }
  return error;
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

  async listPage(query: SubjectKindPageQuery): Promise<CataloguePage<SubjectKindListRow>> {
    // Keyset in the asked-for order, on the people repository's terms (docs/07 §7.3) — with the one
    // extra named order this catalogue counts, `things`. The document count keeps its shape — one
    // per (living thing, document) link, so a document about two things of one kind counts on both
    // — and now, like every count and date on these lists, reads living documents only: what the
    // count is a door to (docs/11 §11.12a) is the browse, which shows exactly those.
    const cursor = decodeCatalogueCursor(query.cursor, query.sort, query.order);
    const rows = await this.prisma.$queryRaw<SubjectKindPageRow[]>`
      WITH page AS (
        SELECT k.id, k.name, k.note, k.created_at AS "createdAt",
               count(DISTINCT s.id)::int AS "subjectCount",
               count(d.id)::int AS "documentCount",
               max(d.document_date) AS "lastDocumentAt"
        FROM subject_kinds k
        LEFT JOIN subjects s ON s.kind_id = k.id AND s.deleted_at IS NULL
        LEFT JOIN document_subjects ds ON ds.subject_id = s.id
        LEFT JOIN documents d ON d.id = ds.document_id AND d.deleted_at IS NULL
        WHERE k.deleted_at IS NULL
        GROUP BY k.id
      )
      SELECT * FROM page
      WHERE ${catalogueKeysetSql(cursor)}
      ORDER BY ${catalogueOrderBySql(query.sort, query.order)}
      LIMIT ${query.limit + 1}
    `;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toSubjectKindListRow),
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCatalogueCursor({
              sort: query.sort,
              order: query.order,
              key: catalogueCursorKeyOf(query.sort, toSubjectKindListRow(last)),
              id: last.id,
            })
          : null,
    };
  }

  async findListRow(id: string, tx?: TransactionHandle): Promise<SubjectKindListRow | null> {
    const rows = await clientOf(this.prisma, tx).$queryRaw<SubjectKindPageRow[]>`
      SELECT k.id, k.name, k.note, k.created_at AS "createdAt",
             count(DISTINCT s.id)::int AS "subjectCount",
             count(d.id)::int AS "documentCount",
             max(d.document_date) AS "lastDocumentAt"
      FROM subject_kinds k
      LEFT JOIN subjects s ON s.kind_id = k.id AND s.deleted_at IS NULL
      LEFT JOIN document_subjects ds ON ds.subject_id = s.id
      LEFT JOIN documents d ON d.id = ds.document_id AND d.deleted_at IS NULL
      WHERE k.deleted_at IS NULL AND k.id = ${id}::uuid
      GROUP BY k.id
    `;
    const row = rows[0];
    return row === undefined ? null : toSubjectKindListRow(row);
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
    try {
      const row = await clientOf(this.prisma, tx).subjectKind.create({
        // As typed: the case is the owner's, and only the uniqueness check ignores it
        // (docs/03 §3.3.20a).
        data: {
          name: input.name.trim(),
          nameFolded: foldName(input.name),
          note: input.note ?? null,
        },
      });
      return toSubjectKind(row);
    } catch (error) {
      throw asSubjectKindExists(error);
    }
  }

  async update(
    id: string,
    input: { name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<SubjectKind> {
    try {
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
    } catch (error) {
      throw asSubjectKindExists(error);
    }
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).subjectKind.update({ where: { id }, data: { deletedAt } });
  }

  countLivingSubjects(id: string, tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).subject.count({ where: { kindId: id, deletedAt: null } });
  }
}
