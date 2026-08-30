import { describe, expect, it } from 'vitest';
import { DomainError, UnprocessableError } from '../../domain/errors/domain-error';
import {
  decodeCatalogueCursor,
  decodeCursor,
  decodeDocumentCursor,
  decodeTextCursor,
  encodeCatalogueCursor,
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
      // 🔒 An id that is not a UUID would reach the driver as a filter on a uuid column and come
      // back as a 500 (SEC-86); a forged cursor starts the list over instead.
      [Buffer.from('1|documentDate|2019-07-04|not-a-uuid').toString('base64url'), 'documentDate'],
      [
        Buffer.from("1|createdAt|2026-03-01T00:00:00.000Z|' OR 1=1").toString('base64url'),
        'createdAt',
      ],
    ];

    for (const [value, sort] of unreadable) {
      expect(decodeDocumentCursor(value, sort)).toBeNull();
    }
    expect(
      decodeCursor(Buffer.from(`2026-03-01T00:00:00.000Z|${ID}`).toString('base64url')),
    ).toBeNull();
    expect(decodeTextCursor(Buffer.from(`A title\u0000${ID}`).toString('base64url'))).toBeNull();
    // The same guard on the other two decoders (SEC-86).
    expect(
      decodeCursor(Buffer.from('1|2026-03-01T00:00:00.000Z|not-a-uuid').toString('base64url')),
    ).toBeNull();
    expect(
      decodeTextCursor(Buffer.from('1\u0000A title\u0000not-a-uuid').toString('base64url')),
    ).toBeNull();
  });
});

// The catalogue lists' cursor (docs/07 §7.3): the documents cursor's discipline, with the
// direction in the question too.
describe('catalogue cursor', () => {
  const ID = 'bbbbbbbb-2222-4222-8222-222222222222';

  it('round-trips each named order, the direction included', () => {
    const cursors = [
      { sort: 'lastDocumentAt', order: 'desc', key: '2019-07-04', id: ID },
      { sort: 'lastDocumentAt', order: 'asc', key: null, id: ID },
      { sort: 'documents', order: 'desc', key: '42', id: ID },
      { sort: 'things', order: 'asc', key: '0', id: ID },
      // A name may hold anything a person can type, the other encodings' delimiter included.
      { sort: 'name', order: 'asc', key: 'Njegoševa 5 | стан 12', id: ID },
    ] as const;
    for (const cursor of cursors) {
      expect(
        decodeCatalogueCursor(encodeCatalogueCursor(cursor), cursor.sort, cursor.order),
      ).toEqual(cursor);
    }
  });

  it('refuses a cursor cut from another sort, and one cut in the other direction', () => {
    const cut = encodeCatalogueCursor({ sort: 'lastDocumentAt', order: 'desc', key: null, id: ID });

    // 🔒 The documents list's rule (docs/07 §7.1): a keyset predicate read off the wrong column —
    // or under the wrong direction — answers instead of failing.
    for (const [sort, order] of [
      ['documents', 'desc'],
      ['lastDocumentAt', 'asc'],
    ] as const) {
      expect(() => decodeCatalogueCursor(cut, sort, order)).toThrow(UnprocessableError);
      const refusal = thrownBy(() => decodeCatalogueCursor(cut, sort, order));
      expect(refusal?.code).toBe('CURSOR_SORT_MISMATCH');
      expect(refusal?.httpStatus).toBe(422);
    }
  });

  it('starts the list over on a cursor it cannot read, rather than erroring', () => {
    const raw = (fields: string[]): string =>
      Buffer.from(fields.join('\u0000')).toString('base64url');

    const unreadable: Array<[string | undefined, 'lastDocumentAt' | 'documents' | 'name']> = [
      [undefined, 'lastDocumentAt'],
      ['', 'lastDocumentAt'],
      // A version this build does not know.
      [raw(['2', 'lastDocumentAt', 'desc', '2019-07-04', ID]), 'lastDocumentAt'],
      // A sort or a direction this build does not know is unreadable, not a mismatch.
      [raw(['1', 'whenever', 'desc', '2019-07-04', ID]), 'lastDocumentAt'],
      [raw(['1', 'lastDocumentAt', 'sideways', '2019-07-04', ID]), 'lastDocumentAt'],
      // A key that does not fit the order it names.
      [raw(['1', 'lastDocumentAt', 'desc', 'not-a-date', ID]), 'lastDocumentAt'],
      [raw(['1', 'documents', 'desc', 'many', ID]), 'documents'],
      // Only the date order has rows without a key; a count is 0 where nothing counts.
      [raw(['1', 'documents', 'desc', '', ID]), 'documents'],
      // No row to continue from.
      [raw(['1', 'name', 'asc', 'Anna', '']), 'name'],
      // 🔒 An id that is not a UUID starts the list over instead of reaching the driver (SEC-86).
      [raw(['1', 'name', 'asc', 'Anna', 'not-a-uuid']), 'name'],
    ];
    for (const [value, sort] of unreadable) {
      expect(decodeCatalogueCursor(value, sort, 'desc')).toBeNull();
    }
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
