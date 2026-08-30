import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Person } from '../../domain/entities/person';
import { ConflictError } from '../../domain/errors/domain-error';
import { foldName } from '../../domain/value-objects/name-fold';
import {
  PersonRepository,
  type CataloguePage,
  type CataloguePageQuery,
  type PersonListRow,
  type PersonWithCount,
} from '../../domain/repositories/person.repository';
import {
  catalogueCursorKeyOf,
  catalogueKeysetSql,
  catalogueOrderBySql,
} from './catalogue-list-sql';
import { decodeCatalogueCursor, encodeCatalogueCursor } from './cursor';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type PersonRow = {
  id: string;
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

// What the list SQL answers per row (docs/07 §7.3): the living row, its count of living documents,
// and the newest `documentDate` among them. Deleted rows never reach the page, so `deletedAt` is
// null by construction rather than carried through the aggregation.
type PersonPageRow = {
  id: string;
  name: string;
  note: string | null;
  createdAt: Date;
  documentCount: number;
  lastDocumentAt: Date | null;
};

function toPersonListRow(row: PersonPageRow): PersonListRow {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: null,
    documentCount: row.documentCount,
    lastDocumentAt: row.lastDocumentAt,
  };
}

// P2002 here can only come from people_name_folded_uq: two writers raced the application's
// uniqueness check and the index picked a winner (docs/04 §4.3).
function asPersonExists(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictError('PERSON_EXISTS', 'A person with this name already exists');
  }
  return error;
}

@Injectable()
export class PrismaPersonRepository extends PersonRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listActive(tx?: TransactionHandle): Promise<PersonWithCount[]> {
    const rows = await clientOf(this.prisma, tx).person.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { documents: true } } },
    });
    return rows.map((row) => ({ ...toPerson(row), documentCount: row._count.documents }));
  }

  async listPage(query: CataloguePageQuery): Promise<CataloguePage<PersonListRow>> {
    // Keyset in the asked-for order (docs/07 §7.3): a forged cursor decodes to null and the page
    // starts over; one cut from another sort or direction is refused (`CURSOR_SORT_MISMATCH`).
    const cursor = decodeCatalogueCursor(query.cursor, query.sort, query.order);
    // Raw SQL because two of the named orders are aggregates — the document count and the newest
    // `documentDate` among the living documents naming the row — which Prisma's object orderBy can
    // neither compute with a soft-delete filter nor keyset over. One aggregation over the living
    // catalogue and a top-N sort, bounded by the catalogue ceiling (docs/04 §4.4).
    const rows = await this.prisma.$queryRaw<PersonPageRow[]>`
      WITH page AS (
        SELECT p.id, p.name, p.note, p.created_at AS "createdAt",
               count(d.id)::int AS "documentCount",
               max(d.document_date) AS "lastDocumentAt"
        FROM people p
        LEFT JOIN document_people dp ON dp.person_id = p.id
        LEFT JOIN documents d ON d.id = dp.document_id AND d.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
      )
      SELECT * FROM page
      WHERE ${catalogueKeysetSql(cursor)}
      ORDER BY ${catalogueOrderBySql(query.sort, query.order)}
      LIMIT ${query.limit + 1}
    `;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toPersonListRow),
      nextCursor:
        rows.length > page.length && last !== undefined
          ? encodeCatalogueCursor({
              sort: query.sort,
              order: query.order,
              key: catalogueCursorKeyOf(query.sort, toPersonListRow(last)),
              id: last.id,
            })
          : null,
    };
  }

  async findListRow(id: string, tx?: TransactionHandle): Promise<PersonListRow | null> {
    const rows = await clientOf(this.prisma, tx).$queryRaw<PersonPageRow[]>`
      SELECT p.id, p.name, p.note, p.created_at AS "createdAt",
             count(d.id)::int AS "documentCount",
             max(d.document_date) AS "lastDocumentAt"
      FROM people p
      LEFT JOIN document_people dp ON dp.person_id = p.id
      LEFT JOIN documents d ON d.id = dp.document_id AND d.deleted_at IS NULL
      WHERE p.deleted_at IS NULL AND p.id = ${id}::uuid
      GROUP BY p.id
    `;
    const row = rows[0];
    return row === undefined ? null : toPersonListRow(row);
  }

  countActive(tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).person.count({ where: { deletedAt: null } });
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Person | null> {
    const row = await clientOf(this.prisma, tx).person.findFirst({
      where: { id, deletedAt: null },
    });
    return row === null ? null : toPerson(row);
  }

  async findByIds(ids: string[], tx?: TransactionHandle): Promise<Person[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).person.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toPerson);
  }

  async findByName(name: string, tx?: TransactionHandle): Promise<Person | null> {
    // 🔒 Matched on the fold, not on ILIKE: the C-collation database folds ASCII alone, and
    // ШЕРШНЕВ has to find Шершнев (docs/03 §3.3.19).
    const row = await clientOf(this.prisma, tx).person.findFirst({
      where: { nameFolded: foldName(name), deletedAt: null },
    });
    return row === null ? null : toPerson(row);
  }

  async create(
    input: { name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Person> {
    try {
      const row = await clientOf(this.prisma, tx).person.create({
        data: {
          name: input.name.trim(),
          nameFolded: foldName(input.name),
          note: input.note ?? null,
        },
      });
      return toPerson(row);
    } catch (error) {
      throw asPersonExists(error);
    }
  }

  async update(
    id: string,
    input: { name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Person> {
    try {
      const row = await clientOf(this.prisma, tx).person.update({
        where: { id },
        data: {
          ...(input.name === undefined
            ? {}
            : { name: input.name.trim(), nameFolded: foldName(input.name) }),
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      });
      return toPerson(row);
    } catch (error) {
      throw asPersonExists(error);
    }
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    // The links stay: a soft-deleted person is one nobody may pick again, not one who was never on
    // the document (ADR-015).
    await clientOf(this.prisma, tx).person.update({ where: { id }, data: { deletedAt } });
  }

  async listForDocument(documentId: string, tx?: TransactionHandle): Promise<Person[]> {
    const rows = await clientOf(this.prisma, tx).documentPerson.findMany({
      where: { documentId, person: { deletedAt: null } },
      include: { person: true },
      orderBy: { person: { name: 'asc' } },
    });
    return rows.map((row) => toPerson(row.person));
  }

  async moveDocumentLinks(fromIds: string[], toId: string, tx?: TransactionHandle): Promise<void> {
    if (fromIds.length === 0) return;
    const client = clientOf(this.prisma, tx);

    // Written as create-then-delete rather than an UPDATE, because a document that named two of the
    // merged rows would collide on the primary key half way through. `skipDuplicates` is exactly the
    // collapse we want; the old rows go afterwards.
    const links = await client.documentPerson.findMany({
      where: { personId: { in: fromIds } },
      select: { documentId: true },
    });
    if (links.length > 0) {
      await client.documentPerson.createMany({
        data: links.map((link) => ({ documentId: link.documentId, personId: toId })),
        skipDuplicates: true,
      });
    }
    await client.documentPerson.deleteMany({ where: { personId: { in: fromIds } } });
  }

  async setForDocument(
    documentId: string,
    personIds: string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    // An empty set means "nobody", which is a deleteMany with no exclusion — `notIn: []` would be a
    // uuid comparison against nothing, and Prisma rejects the placeholder that would need.
    await client.documentPerson.deleteMany({
      where: {
        documentId,
        ...(personIds.length === 0 ? {} : { personId: { notIn: personIds } }),
      },
    });
    if (personIds.length > 0) {
      await client.documentPerson.createMany({
        data: personIds.map((personId) => ({ documentId, personId })),
        skipDuplicates: true,
      });
    }
  }
}
