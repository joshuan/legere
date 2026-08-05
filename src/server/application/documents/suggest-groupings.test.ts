import { describe, expect, it } from 'vitest';
import { suggestGroupings, type GroupingCandidate } from './suggest-groupings';

// The rule of docs/05 §5.6a: which single-file scans look like pages of one document. Pure
// arithmetic over names and times, so it is tested without a database — what reaches it is already
// filtered to single-file image documents nobody has touched.

const MINUTE = 60_000;
const RULES = { windowMs: 10 * MINUTE, limit: 20 };
const BASE = Date.UTC(2026, 6, 14, 11, 0, 0);

let seq = 0;

function candidate(overrides: Partial<GroupingCandidate> = {}): GroupingCandidate {
  seq += 1;
  return {
    documentId: `doc-${seq}`,
    libraryId: 'library-1',
    libraryName: 'Papers',
    folder: 'scans',
    name: `IMG_${String(seq).padStart(4, '0')}.jpg`,
    mtimeMs: BASE + seq * MINUTE,
    createdAt: new Date(BASE),
    ...overrides,
  };
}

describe('suggestGroupings', () => {
  it('proposes a run of names scanned in one sitting', () => {
    const items = suggestGroupings(
      [
        candidate({ documentId: 'a', name: 'passport-01.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', name: 'passport-02.jpg', mtimeMs: BASE + MINUTE }),
        candidate({ documentId: 'c', name: 'passport-03.jpg', mtimeMs: BASE + 2 * MINUTE }),
      ],
      RULES,
    );

    expect(items).toEqual([
      {
        documentIds: ['a', 'b', 'c'],
        libraryId: 'library-1',
        libraryName: 'Papers',
        folder: 'scans',
        reason: 'NAME_SEQUENCE',
      },
    ]);
  });

  it('never proposes a group of one', () => {
    expect(suggestGroupings([candidate({ name: 'passport-01.jpg' })], RULES)).toEqual([]);
  });

  it('forgives one missing number but not two', () => {
    const withGap = suggestGroupings(
      [
        candidate({ documentId: 'a', name: 'scan-1.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', name: 'scan-3.jpg', mtimeMs: BASE + MINUTE }),
      ],
      RULES,
    );
    expect(withGap[0]?.documentIds).toEqual(['a', 'b']);

    const withChasm = suggestGroupings(
      [
        candidate({ documentId: 'a', name: 'scan-1.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', name: 'scan-9.jpg', mtimeMs: BASE + MINUTE }),
      ],
      RULES,
    );
    // Two numbers apart is a different stack of paper, not a page that failed to scan. What is left
    // is two files in one folder minutes apart, which is one sitting.
    expect(withChasm[0]?.reason).toBe('SAME_SITTING');
  });

  it('keeps folders and libraries apart', () => {
    const items = suggestGroupings(
      [
        candidate({ documentId: 'a', folder: 'scans', name: 'p-1.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', folder: 'other', name: 'p-2.jpg', mtimeMs: BASE + MINUTE }),
        candidate({
          documentId: 'c',
          libraryId: 'library-2',
          folder: 'scans',
          name: 'p-3.jpg',
          mtimeMs: BASE + 2 * MINUTE,
        }),
      ],
      RULES,
    );

    // Files filed apart were filed apart on purpose (docs/05 §5.6a).
    expect(items).toEqual([]);
  });

  it('splits a sequence where the scanner was left alone for longer than the window', () => {
    const items = suggestGroupings(
      [
        candidate({ documentId: 'a', name: 'p-1.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', name: 'p-2.jpg', mtimeMs: BASE + MINUTE }),
        candidate({ documentId: 'c', name: 'p-3.jpg', mtimeMs: BASE + 90 * MINUTE }),
        candidate({ documentId: 'd', name: 'p-4.jpg', mtimeMs: BASE + 91 * MINUTE }),
      ],
      RULES,
    );

    expect(items.map((item) => item.documentIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('holds a long sitting together, because a gap and a span are not the same thing', () => {
    const forty = Array.from({ length: 40 }, (_, index) =>
      candidate({
        documentId: `page-${index}`,
        name: `passport-${String(index + 1).padStart(2, '0')}.jpg`,
        // Twenty seconds a page: an hour from first to last, and never a pause.
        mtimeMs: BASE + index * 20_000,
      }),
    );

    const items = suggestGroupings(forty, RULES);

    expect(items).toHaveLength(1);
    expect(items[0]?.documentIds).toHaveLength(40);
  });

  it('groups names that say nothing by the sitting they were made in', () => {
    const items = suggestGroupings(
      [
        candidate({ documentId: 'a', name: 'front.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', name: 'back.jpg', mtimeMs: BASE + 2 * MINUTE }),
        candidate({ documentId: 'c', name: 'unrelated.jpg', mtimeMs: BASE + 300 * MINUTE }),
      ],
      RULES,
    );

    expect(items).toEqual([
      {
        documentIds: ['a', 'b'],
        libraryId: 'library-1',
        libraryName: 'Papers',
        folder: 'scans',
        reason: 'SAME_SITTING',
      },
    ]);
  });

  it('reads numbers however they are padded, and ignores the extension', () => {
    const items = suggestGroupings(
      [
        candidate({ documentId: 'a', name: 'IMG_0042.jpg', mtimeMs: BASE }),
        candidate({ documentId: 'b', name: 'IMG_0043.jpeg', mtimeMs: BASE + MINUTE }),
      ],
      RULES,
    );

    expect(items[0]?.reason).toBe('NAME_SEQUENCE');
  });

  it('offers the newest groups first and never more than it was asked for', () => {
    const older = [
      candidate({ documentId: 'old-1', name: 'a-1.jpg', createdAt: new Date(BASE) }),
      candidate({ documentId: 'old-2', name: 'a-2.jpg', createdAt: new Date(BASE) }),
    ];
    const newer = [
      candidate({
        documentId: 'new-1',
        folder: 'later',
        name: 'b-1.jpg',
        createdAt: new Date(BASE + 5 * MINUTE),
      }),
      candidate({
        documentId: 'new-2',
        folder: 'later',
        name: 'b-2.jpg',
        createdAt: new Date(BASE + 5 * MINUTE),
      }),
    ];

    const items = suggestGroupings([...older, ...newer], { windowMs: 10 * MINUTE, limit: 1 });

    expect(items).toHaveLength(1);
    expect(items[0]?.documentIds).toEqual(['new-1', 'new-2']);
  });
});
