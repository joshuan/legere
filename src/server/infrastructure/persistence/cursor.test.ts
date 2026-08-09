import { describe, expect, it } from 'vitest';
import { DomainError, UnprocessableError } from '../../domain/errors/domain-error';
import {
  decodeCursor,
  decodeDocumentCursor,
  decodeTextCursor,
  encodeCursor,
  encodeDocumentCursor,
  encodeTextCursor,
} from './cursor';

// The cursor encoding and the two rules it grows by (docs/07 §7.1).
describe('cursor', () => {
  const ID = 'aaaaaaaa-1111-4111-8111-111111111111';

  it('round-trips a timestamp cursor', () => {
    const at = new Date('2026-03-01T10:20:30.400Z');
    expect(decodeCursor(encodeCursor({ at, id: ID }))).toEqual({ at, id: ID });
  });

  it('round-trips a text cursor whose key holds the separators', () => {
    // A document title may hold anything a person can type, the delimiter of the other encoding
    // included (docs/07 §7.3).
    const key = 'A title | with pipes | and spaces';
    expect(decodeTextCursor(encodeTextCursor({ key, id: ID }))).toEqual({ key, id: ID });
  });

  it('round-trips a document cursor in each of the three orders', () => {
    expect(
      decodeDocumentCursor(
        encodeDocumentCursor({ sort: 'documentDate', key: '2019-07-04', id: ID }),
        'documentDate',
      ),
    ).toEqual({ sort: 'documentDate', key: '2019-07-04', id: ID });

    const at = '2026-03-01T10:20:30.400Z';
    for (const sort of ['createdAt', 'lastEventAt'] as const) {
      expect(decodeDocumentCursor(encodeDocumentCursor({ sort, key: at, id: ID }), sort)).toEqual({
        sort,
        key: at,
        id: ID,
      });
    }
  });

  it('carries "this document has no date" as a place in the order rather than as a missing value', () => {
    const cursor = encodeDocumentCursor({ sort: 'documentDate', key: null, id: ID });

    expect(decodeDocumentCursor(cursor, 'documentDate')).toEqual({
      sort: 'documentDate',
      key: null,
      id: ID,
    });
  });

  it('refuses a cursor cut from another order rather than reading it off this column', () => {
    const cut = encodeDocumentCursor({
      sort: 'createdAt',
      key: '2026-03-01T00:00:00.000Z',
      id: ID,
    });

    // 🔒 A keyset predicate on the wrong column answers instead of failing, skipping and repeating
    // rows while looking like an ordinary page (docs/07 §7.1).
    expect(() => decodeDocumentCursor(cut, 'documentDate')).toThrow(UnprocessableError);

    const refusal = thrownBy(() => decodeDocumentCursor(cut, 'documentDate'));
    expect(refusal?.code).toBe('CURSOR_SORT_MISMATCH');
    expect(refusal?.httpStatus).toBe(422);
  });

  it('starts the list over on a cursor it cannot read at all, rather than erroring', () => {
    // Each paired with the order it is handed to, so nothing here is a mismatch in disguise — a
    // mismatch is refused, and that is the test above.
    const unreadable: Array<[string | undefined, 'documentDate' | 'createdAt']> = [
      [undefined, 'documentDate'],
      ['', 'documentDate'],
      // The unversioned encoding this file used before the orders existed: a page held open across
      // a deploy recovers by starting again, which is the only thing a client can do with an opaque
      // string it cannot repair.
      [Buffer.from(`2026-03-01T00:00:00.000Z|${ID}`).toString('base64url'), 'documentDate'],
      // A version this build does not know.
      [Buffer.from(`2|documentDate|2019-07-04|${ID}`).toString('base64url'), 'documentDate'],
      // A key that does not fit the order it names.
      [Buffer.from(`1|documentDate|not-a-date|${ID}`).toString('base64url'), 'documentDate'],
      [Buffer.from(`1|createdAt|not-a-timestamp|${ID}`).toString('base64url'), 'createdAt'],
      // Only the date on a document may be absent; a clock order has no such row.
      [Buffer.from(`1|createdAt||${ID}`).toString('base64url'), 'createdAt'],
      // An order this build does not know.
      [Buffer.from(`1|whenever|2019-07-04|${ID}`).toString('base64url'), 'documentDate'],
      // No row to continue from.
      [Buffer.from('1|documentDate|2019-07-04|').toString('base64url'), 'documentDate'],
    ];

    for (const [value, sort] of unreadable) {
      expect(decodeDocumentCursor(value, sort)).toBeNull();
    }
    expect(
      decodeCursor(Buffer.from(`2026-03-01T00:00:00.000Z|${ID}`).toString('base64url')),
    ).toBeNull();
    expect(decodeTextCursor(Buffer.from(`A title\u0000${ID}`).toString('base64url'))).toBeNull();
  });
});

// The error a refusal carries, reached without a type assertion.
function thrownBy(run: () => unknown): DomainError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error : null;
  }
}
