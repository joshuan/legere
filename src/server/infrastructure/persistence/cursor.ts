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
  if (timestamp === undefined || id === undefined || id === '') return null;

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
  return id === '' ? null : { key: decoded.slice(afterVersion + 1, beforeId), id };
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
  if (name === undefined || key === undefined || id === undefined || id === '') return null;

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
