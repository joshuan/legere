import { Prisma } from '@prisma/client';
import type { CatalogueOrder, SubjectKindSort } from '../../../shared/contracts/common';
import type { CatalogueCursor } from './cursor';

// The SQL behind the three catalogue lists' named orders (docs/07 §7.3). Each repository aggregates
// its living rows into one page CTE — the row, its counts, and `lastDocumentAt`, the newest
// `documentDate` among the living documents that name it — and the fragments below arrange and cut
// that CTE the same way for all three, so the sort semantics cannot drift apart per catalogue.
//
// Deliberately no index (docs/04 §4.4): every key here except the name is an aggregate — a
// `max()` over a join, a link count — which no index can order by, so each page is one aggregation
// over the living catalogue and a top-N sort. What bounds it is not an index but the catalogue
// ceilings themselves (10 000 people / 20 000 subjects / 500 kinds, docs/08 §8.4) and the link
// tables' own PKs feeding the joins.

// The CTE column each named order reads. A closed map over the contract enum, so nothing a caller
// sends ever reaches the statement text — `Prisma.raw` below only ever sees these literals.
const SORT_COLUMNS = {
  lastDocumentAt: '"lastDocumentAt"',
  documents: '"documentCount"',
  things: '"subjectCount"',
  name: 'name',
} as const satisfies Record<SubjectKindSort, string>;

// `ORDER BY <key> <direction>, id ASC`. The dateless rows sort last under either direction
// (docs/11 §11.12a): a row the archive has no dated paper for is the least current answer to "what
// did the paper last name", whichever way the column is read. The id tiebreak always ascends, so a
// page continues below its cursor even where the whole page ties on one date or one count.
export function catalogueOrderBySql(sort: SubjectKindSort, order: CatalogueOrder): Prisma.Sql {
  const column = Prisma.raw(SORT_COLUMNS[sort]);
  const direction = Prisma.raw(order === 'asc' ? 'ASC' : 'DESC');
  if (sort === 'lastDocumentAt') {
    return Prisma.sql`${column} ${direction} NULLS LAST, id ASC`;
  }
  return Prisma.sql`${column} ${direction}, id ASC`;
}

// The keyset predicate continuing a page below its cursor, over the same CTE columns. `TRUE` for
// the first page keeps the callers' statements one shape. The id is compared as text, the way the
// browse-by-folder keyset already does: the canonical lowercase form orders the same both ways.
export function catalogueKeysetSql(cursor: CatalogueCursor | null): Prisma.Sql {
  if (cursor === null) return Prisma.sql`TRUE`;

  const column = Prisma.raw(SORT_COLUMNS[cursor.sort]);
  const beyond = Prisma.raw(cursor.order === 'asc' ? '>' : '<');

  if (cursor.sort === 'lastDocumentAt') {
    // A nullable sort key, so the predicate mirrors the documents list's three branches — with the
    // blocks the other way up, since here the dateless sort *last*: from inside the dateless block
    // only ids continue; from the dated block the rest of the dates follow, and then the whole
    // dateless block, under either direction.
    if (cursor.key === null) {
      return Prisma.sql`(${column} IS NULL AND id::text > ${cursor.id})`;
    }
    return Prisma.sql`(
      ${column} IS NULL
      OR ${column} ${beyond} ${cursor.key}::date
      OR (${column} = ${cursor.key}::date AND id::text > ${cursor.id})
    )`;
  }

  if (cursor.sort === 'name') {
    return Prisma.sql`(
      name ${beyond} ${cursor.key}
      OR (name = ${cursor.key} AND id::text > ${cursor.id})
    )`;
  }

  const count = Number(cursor.key);
  return Prisma.sql`(
    ${column} ${beyond} ${count}
    OR (${column} = ${count} AND id::text > ${cursor.id})
  )`;
}

// The sort key of one answered row, in the shape the cursor carries it. Every caller's page rows
// carry all three values (`things` is the kinds catalogue's own and 0 elsewhere — a sort the other
// two lists' contracts never admit).
export function catalogueCursorKeyOf(
  sort: SubjectKindSort,
  row: { name: string; documentCount: number; subjectCount?: number; lastDocumentAt: Date | null },
): string | null {
  switch (sort) {
    case 'lastDocumentAt':
      return row.lastDocumentAt === null ? null : row.lastDocumentAt.toISOString().slice(0, 10);
    case 'documents':
      return String(row.documentCount);
    case 'things':
      return String(row.subjectCount ?? 0);
    case 'name':
      return row.name;
  }
}
