import {
  catalogueOrderSchema,
  subjectKindSortSchema,
  type CatalogueOrder,
  type SubjectKindSort,
} from '../../../shared/contracts/common';
import { documentSortSchema, type DocumentSort } from '../../../shared/contracts/documents';
import { UnprocessableError } from '../../domain/errors/domain-error';

// Opaque cursors for keyset pagination (docs/07 §7.1). A cursor encodes the sort key of the last
// item returned — a timestamp plus the row id as a tiebreak, since timestamps collide. Base64url so
// it survives a query string; opaque to clients, which must only echo it back.
//
// 🔒 **How the encoding grows.** Every cursor now begins with a version, and the one cut by a list
// that offers more than one order also names the order it was cut from. Both exist for the same
// reason: a cursor is opaque but not secret — anybody can write one — and a keyset predicate read
// off the wrong column does not fail, it answers, skipping and repeating rows while looking like an
// ordinary page. So the rule for the next change to this file is the one applied here:
//
//   1. adding or reinterpreting a field bumps `CURSOR_VERSION`, and a cursor of any other version
//      is treated as unreadable;
//   2. **unreadable is not an error** — a client cannot repair an opaque string, so the list starts
//      from the beginning, which is also how a page held open across a deploy recovers;
//   3. **readable but answering a different question is an error** — a cursor that names order A
//      handed to a request asking for order B is refused (`CURSOR_SORT_MISMATCH`, 422), because
//      here there *is* a right answer and quietly giving the wrong one is worse than saying no.
const CURSOR_VERSION = '1';

// 🔒 The id is compared against a `@db.Uuid` column, and Prisma answers a non-UUID there with a
// P2023 nothing maps — a 500 where rule 2 promises a fresh first page (SEC-86, the shape SEC-44's
// fix already gave the queue cursor). The literal is `uuid-param.pipe.ts`'s.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Cursor = { at: Date; id: string };

export function encodeCursor(cursor: Cursor): string {
  return encode([CURSOR_VERSION, cursor.at.toISOString(), cursor.id]);
}

// A malformed cursor decodes to null and the caller starts from the beginning rather than erroring:
// cursors are opaque, so a client cannot reasonably repair one.
export function decodeCursor(value: string | undefined): Cursor | null {
  const fields = decode(value, 3);
  if (fields === null) return null;
  const [, timestamp, id] = fields;
  if (timestamp === undefined || id === undefined || !UUID.test(id)) return null;

  const at = new Date(timestamp);
  return Number.isNaN(at.getTime()) ? null : { at, id };
}

// Some pages are ordered by a string rather than a timestamp (browse sorts documents by title,
// docs/07 §7.3). Same shape, same opacity — the sort key just happens to be text.
export type TextCursor = { key: string; id: string };

// `\u0000` rather than `|`, because the key here is a document title and a title may hold anything
// a person can type. The version is still the first field, read up to the first separator; the id is
// the last, read back from the last one.
export function encodeTextCursor(cursor: TextCursor): string {
  return Buffer.from(`${CURSOR_VERSION}\u0000${cursor.key}\u0000${cursor.id}`).toString(
    'base64url',
  );
}

export function decodeTextCursor(value: string | undefined): TextCursor | null {
  if (value === undefined || value === '') return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');

  const afterVersion = decoded.indexOf('\u0000');
  if (afterVersion < 0 || decoded.slice(0, afterVersion) !== CURSOR_VERSION) return null;

  const beforeId = decoded.lastIndexOf('\u0000');
  if (beforeId <= afterVersion) return null;

  const id = decoded.slice(beforeId + 1);
  return UUID.test(id) ? { key: decoded.slice(afterVersion + 1, beforeId), id } : null;
}

// The cursor of a document list (docs/07 §7.3). Beyond the version it carries the order it was cut
// from, and a key whose shape follows that order: an ISO timestamp for the two clock orders,
// `yyyy-mm-dd` for the date on the document, and **null** for a document that carries no date —
// which is a place in the ordering of its own, not a missing value, since the undated sort ahead of
// everything (`ORDER BY document_date DESC NULLS FIRST, id DESC`).
export type DocumentCursor = { sort: DocumentSort; key: string | null; id: string };

export function encodeDocumentCursor(cursor: DocumentCursor): string {
  return encode([CURSOR_VERSION, cursor.sort, cursor.key ?? '', cursor.id]);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 🔒 Throws `CURSOR_SORT_MISMATCH` when the cursor names an order other than the one being asked
// for. Everything else unreadable — a stale version, a key that does not fit its order, a sort name
// this build does not know — is null, and the list starts over.
export function decodeDocumentCursor(
  value: string | undefined,
  sort: DocumentSort,
): DocumentCursor | null {
  const fields = decode(value, 4);
  if (fields === null) return null;
  const [, name, key, id] = fields;
  if (name === undefined || key === undefined || id === undefined || !UUID.test(id)) return null;

  const parsed = documentSortSchema.safeParse(name);
  if (!parsed.success) return null;
  if (parsed.data !== sort) {
    throw new UnprocessableError(
      'CURSOR_SORT_MISMATCH',
      `This cursor was cut from the "${parsed.data}" order and cannot continue a "${sort}" one`,
    );
  }

  if (key === '') {
    // Only the date on the document is allowed to be absent; a timestamp order has no such row.
    return sort === 'documentDate' ? { sort, key: null, id } : null;
  }
  if (sort === 'documentDate') {
    return ISO_DATE.test(key) ? { sort, key, id } : null;
  }
  return Number.isNaN(new Date(key).getTime()) ? null : { sort, key, id };
}

// The cursor of a catalogue list (docs/07 §7.3): the documents cursor's discipline over the
// people-shaped tables. Beyond the version it names the whole question it was cut from — the sort
// *and* the direction, because a keyset predicate read under the other direction answers just as
// quietly wrong — and a key whose shape follows the sort: `yyyy-mm-dd` for `lastDocumentAt` with
// **null** for a row no dated document names (a place in the order of its own, since the dateless
// sort behind everything under either direction), a decimal count for the two counted orders, and
// the name itself for `name`. The widest sort enum covers all three catalogues: a people cursor can
// never legitimately say `things`, and one that does simply names an order the request did not ask
// for.
export type CatalogueCursor = {
  sort: SubjectKindSort;
  order: CatalogueOrder;
  key: string | null;
  id: string;
};

// `\u0000` separators rather than `|`: the name order's key is a catalogue name, and a name may
// hold anything a person can type (Postgres text never holds NUL, so the separator is safe).
export function encodeCatalogueCursor(cursor: CatalogueCursor): string {
  return Buffer.from(
    [CURSOR_VERSION, cursor.sort, cursor.order, cursor.key ?? '', cursor.id].join('\u0000'),
  ).toString('base64url');
}

const COUNT_KEY = /^\d+$/;

// 🔒 Throws `CURSOR_SORT_MISMATCH` when the cursor names a sort or a direction other than the one
// being asked for — the documents list's rule, for the documents list's reason (docs/07 §7.1).
// Everything else unreadable — a stale version, a key that does not fit its order — is null, and
// the list starts over.
export function decodeCatalogueCursor(
  value: string | undefined,
  sort: SubjectKindSort,
  order: CatalogueOrder,
): CatalogueCursor | null {
  if (value === undefined || value === '') return null;
  const fields = Buffer.from(value, 'base64url').toString('utf8').split('\u0000');
  if (fields.length !== 5 || fields[0] !== CURSOR_VERSION) return null;
  const [, name, direction, key, id] = fields;
  if (name === undefined || direction === undefined || key === undefined || id === undefined) {
    return null;
  }
  if (!UUID.test(id)) return null;

  const parsedSort = subjectKindSortSchema.safeParse(name);
  const parsedOrder = catalogueOrderSchema.safeParse(direction);
  if (!parsedSort.success || !parsedOrder.success) return null;
  if (parsedSort.data !== sort || parsedOrder.data !== order) {
    throw new UnprocessableError(
      'CURSOR_SORT_MISMATCH',
      `This cursor was cut from the "${parsedSort.data} ${parsedOrder.data}" order and cannot continue a "${sort} ${order}" one`,
    );
  }

  if (key === '') {
    // Only the date order has rows without a key; a count is 0 where nothing counts, and a name is
    // never empty.
    return sort === 'lastDocumentAt' ? { sort, order, key: null, id } : null;
  }
  if (sort === 'lastDocumentAt') {
    return ISO_DATE.test(key) ? { sort, order, key, id } : null;
  }
  if (sort === 'documents' || sort === 'things') {
    return COUNT_KEY.test(key) ? { sort, order, key, id } : null;
  }
  return { sort, order, key, id };
}

function encode(fields: readonly string[]): string {
  return Buffer.from(fields.join('|')).toString('base64url');
}

// Exactly `count` fields or nothing: neither a timestamp, a `yyyy-mm-dd`, a uuid nor a sort name
// contains `|`, so a cursor with a different number of them is not one this version wrote.
function decode(value: string | undefined, count: number): string[] | null {
  if (value === undefined || value === '') return null;
  const fields = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (fields.length !== count || fields[0] !== CURSOR_VERSION) return null;
  return fields;
}
