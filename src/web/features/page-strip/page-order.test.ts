import { describe, expect, it } from 'vitest';
import type {
  DocumentFileDto,
  DocumentPageDto,
  Rotation,
} from '../../../shared/contracts/documents';
import {
  canCrop,
  canMirror,
  canTurn,
  hasPicture,
  movePage,
  sameOrder,
  sameTurn,
  standsForWholeFile,
  storedOrder,
  turnOf,
  turnedPage,
  turnsToSave,
} from './page-order';

// The arithmetic the strip is built on (docs/03 §3.3.17, docs/11 §11.5a), asked without rendering
// anything: where a page lands, what has changed since the server last spoke, and what may be done
// to an entry that is not a page yet.

function page(overrides: Partial<DocumentPageDto> & { id: string }): DocumentPageDto {
  return {
    position: 0,
    fileId: 'file-1',
    pageIndex: 0,
    turn: null,
    crop: null,
    cropSource: 'NONE',
    ...overrides,
  };
}

function file(overrides: Partial<DocumentFileDto> = {}): DocumentFileDto {
  return {
    id: 'file-1',
    position: 0,
    name: 'lease.pdf',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: '1024',
    origin: 'MANAGED',
    available: true,
    isImage: false,
    crop: null,
    cropSource: 'NONE',
    rotation: null,
    pageOrder: null,
    pageRotations: null,
    pageCount: 2,
    refs: [],
    storageKey: null,
    earlierVersions: [],
    ...overrides,
  };
}

const QUARTER: Rotation = { quarterTurns: 1, mirrored: false };

describe('movePage', () => {
  it('takes a page out and puts it back, the rest closing up behind it', () => {
    expect(movePage(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(movePage(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  // A page at the end asked to move further along stays where it is: the last position is the last
  // position, and an arrow key that wrapped would move a page nobody aimed at (docs/11 §11.5a).
  it('refuses a position outside the strip rather than clamping or wrapping', () => {
    expect(movePage(['a', 'b', 'c'], 2, 3)).toEqual(['a', 'b', 'c']);
    expect(movePage(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(movePage(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('storedOrder', () => {
  it('reads the order off the positions rather than off the array it arrived in', () => {
    expect(
      storedOrder([
        page({ id: 'c', position: 2 }),
        page({ id: 'a', position: 0 }),
        page({ id: 'b', position: 1 }),
      ]),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('sameOrder', () => {
  it('compares a strip with what the document says, item by item', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('turnedPage', () => {
  it('turns a quarter at a time and comes back to nothing after four', () => {
    let turn: Rotation | null = null;
    for (const step of [1, 2, 3]) {
      turn = turnedPage(turn, 'RIGHT');
      expect(turn?.quarterTurns).toBe(step);
    }
    // 🔒 A turn of nothing at all is stored as nothing, so a page pressed round in a circle stops
    // claiming to be turned (docs/03 §3.3.17).
    expect(turnedPage(turn, 'RIGHT')).toBeNull();
  });
});

describe('sameTurn', () => {
  it('reads null and a turn of nothing at all as the one thing they are', () => {
    expect(sameTurn(null, { quarterTurns: 0, mirrored: false })).toBe(true);
    expect(sameTurn(null, null)).toBe(true);
    expect(sameTurn(QUARTER, QUARTER)).toBe(true);
    expect(sameTurn(QUARTER, null)).toBe(false);
    expect(sameTurn(QUARTER, { quarterTurns: 1, mirrored: true })).toBe(false);
  });
});

describe('turnOf', () => {
  it('answers with what the strip is holding, or with what the document says', () => {
    const held = page({ id: 'a', turn: QUARTER });
    expect(turnOf(held, new Map())).toEqual(QUARTER);
    expect(turnOf(held, new Map([['a', null]]))).toBeNull();
  });
});

describe('turnsToSave', () => {
  it('sends only the pages whose turn the document does not already say', () => {
    const pages = [
      page({ id: 'a', position: 0 }),
      page({ id: 'b', position: 1, turn: QUARTER }),
      page({ id: 'c', position: 2 }),
    ];
    const pending = new Map<string, Rotation | null>([
      // Turned, and worth a request.
      ['a', QUARTER],
      // Pressed round in a circle back to what it already was — not an edit (docs/11 §11.5a).
      ['b', QUARTER],
      // Cleared, which is an edit.
      ['c', null],
    ]);

    expect(turnsToSave(pages, pending)).toEqual([{ pageId: 'a', turn: QUARTER }]);
  });

  it('sends nothing at all while the strip has been touched by nobody', () => {
    expect(turnsToSave([page({ id: 'a' })], new Map())).toEqual([]);
  });
});

describe('what may be done to an entry', () => {
  // 🔒 A file nobody has counted the pages of is held as one entry standing for the whole of it, and
  // there is no page of it to draw, to turn or to crop (docs/03 §3.3.17, ADR-025).
  it('offers nothing on a file held whole', () => {
    const held = page({ id: 'a', pageIndex: null });
    const pdf = file({ pageCount: null });

    expect(standsForWholeFile(held)).toBe(true);
    expect(hasPicture(held, pdf)).toBe(false);
    expect(canTurn(held, pdf)).toBe(false);
    expect(canCrop(held, pdf)).toBe(false);
  });

  it('offers everything on a counted page of a PDF, and no mirror', () => {
    const counted = page({ id: 'a', pageIndex: 1 });
    const pdf = file();

    expect(hasPicture(counted, pdf)).toBe(true);
    expect(canTurn(counted, pdf)).toBe(true);
    expect(canCrop(counted, pdf)).toBe(true);
    // A PDF page arrives the way its producer laid it out (docs/11 §11.5c).
    expect(canMirror(pdf)).toBe(false);
  });

  // An image is one page and always was, whatever a page count says.
  it('treats an image as a page even while nothing has counted it', () => {
    const photograph = page({ id: 'a', pageIndex: null });
    const jpg = file({ isImage: true, mimeType: 'image/jpeg', pageCount: null });

    expect(hasPicture(photograph, jpg)).toBe(true);
    expect(canTurn(photograph, jpg)).toBe(true);
    expect(canCrop(photograph, jpg)).toBe(true);
    expect(canMirror(jpg)).toBe(true);
  });

  it('offers nothing where the document no longer describes the file', () => {
    const orphan = page({ id: 'a', fileId: 'gone' });

    expect(hasPicture(orphan, undefined)).toBe(false);
    expect(canTurn(orphan, undefined)).toBe(false);
    expect(canMirror(undefined)).toBe(false);
  });
});
