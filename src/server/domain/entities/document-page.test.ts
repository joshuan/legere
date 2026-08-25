import { describe, expect, it } from 'vitest';
import {
  canOverwriteCrop,
  effectiveTurn,
  fileCropOf,
  fileCropSourceOf,
  filePageOrderOf,
  filePageRotationsOf,
  fileTurnOf,
  pagesOfFile,
  samePages,
  standsForWholeFile,
  withExpandedPages,
  withFileCrop,
  withFilePageOrder,
  withFilePageTurns,
  withFileTurn,
  type DocumentPage,
} from './document-page';
import type { Crop } from '../../../shared/contracts/documents';

// A document is an ordered list of pages (ADR-025), and this is what that list can be asked and told
// without a database in the room: what one file says about the document reading it, and what the
// list should look like after an edit.

const QUAD: Crop = {
  points: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
};

function page(overrides: Partial<DocumentPage> = {}): DocumentPage {
  return {
    id: `page-${overrides.position ?? 0}`,
    documentId: 'doc-1',
    position: 0,
    fileId: 'file-1',
    pageIndex: 0,
    turn: null,
    crop: null,
    cropSource: 'NONE',
    ...overrides,
  };
}

// A three-page scan and a photograph after it, which is the shape most of these questions are about.
function listOf(): DocumentPage[] {
  return [
    page({ position: 0, pageIndex: 0 }),
    page({ position: 1, pageIndex: 1 }),
    page({ position: 2, pageIndex: 2 }),
    page({ position: 3, fileId: 'file-2', pageIndex: null }),
  ];
}

describe('what one page says', () => {
  it('answers nothing for a page nobody has turned', () => {
    expect(effectiveTurn({ turn: null })).toBeNull();
    // A turn of nothing is not worth re-encoding a page for: four presses of rotate-right leave a
    // stored value that says the page arrived this way up.
    expect(effectiveTurn({ turn: { quarterTurns: 0, mirrored: false } })).toBeNull();
    expect(effectiveTurn({ turn: { quarterTurns: 3, mirrored: false } })).toEqual({
      quarterTurns: 3,
      mirrored: false,
    });
  });

  it('keeps a crop somebody dragged away from the machine', () => {
    expect(canOverwriteCrop({ cropSource: 'NONE' })).toBe(true);
    expect(canOverwriteCrop({ cropSource: 'AUTO' })).toBe(true);
    expect(canOverwriteCrop({ cropSource: 'MANUAL' })).toBe(false);
  });

  it('knows the entry that stands for a file whole', () => {
    expect(standsForWholeFile({ pageIndex: null })).toBe(true);
    expect(standsForWholeFile({ pageIndex: 0 })).toBe(false);
  });
});

describe('what one file says about the document reading it', () => {
  it('reads a crop and a turn off the page an image is read as', () => {
    const pages = [
      page({ crop: QUAD, cropSource: 'MANUAL', turn: { quarterTurns: 1, mirrored: true } }),
    ];
    expect(fileCropOf(pages)).toEqual(QUAD);
    expect(fileCropSourceOf(pages)).toBe('MANUAL');
    expect(fileTurnOf(pages)).toEqual({ quarterTurns: 1, mirrored: true });
    expect(fileCropOf([])).toBeNull();
    expect(fileCropSourceOf([])).toBe('NONE');
    expect(fileTurnOf([])).toBeNull();
  });

  it('answers no page order for pages read straight through', () => {
    const pages = pagesOfFile(listOf(), 'file-1');
    expect(filePageOrderOf(pages, 3)).toBeNull();
    // And none at all while nobody has counted the pages, or while the document holds only some.
    expect(filePageOrderOf(pagesOfFile(listOf(), 'file-2'), null)).toBeNull();
    expect(filePageOrderOf(pages, 4)).toBeNull();
  });

  it('answers the order this document reads a file in', () => {
    const shuffled = [
      page({ position: 0, pageIndex: 2 }),
      page({ position: 1, pageIndex: 0 }),
      page({ position: 2, pageIndex: 1 }),
    ];
    expect(filePageOrderOf(shuffled, 3)).toEqual([2, 0, 1]);
  });

  it('answers the turns by the file own page index, not by where the pages sit', () => {
    const pages = [
      page({ position: 0, pageIndex: 2, turn: { quarterTurns: 1, mirrored: false } }),
      page({ position: 1, pageIndex: 0 }),
      page({ position: 2, pageIndex: 1 }),
    ];
    expect(filePageRotationsOf(pages, 3)).toEqual([0, 0, 1]);
    // Nothing turned is one word rather than a list of noughts, and an uncounted file has no list.
    expect(filePageRotationsOf(pagesOfFile(listOf(), 'file-1'), 3)).toBeNull();
    expect(filePageRotationsOf(pagesOfFile(listOf(), 'file-2'), null)).toBeNull();
  });
});

describe('rewriting the list', () => {
  it('says a crop and a turn about the pages of one file and leaves the rest alone', () => {
    const cropped = withFileCrop(listOf(), 'file-2', QUAD, 'MANUAL');
    expect(cropped.map((entry) => entry.crop)).toEqual([null, null, null, QUAD]);
    expect(cropped.map((entry) => entry.cropSource)).toEqual(['NONE', 'NONE', 'NONE', 'MANUAL']);

    const turned = withFileTurn(listOf(), 'file-2', { quarterTurns: 1, mirrored: false });
    expect(turned.map((entry) => entry.turn)).toEqual([
      null,
      null,
      null,
      { quarterTurns: 1, mirrored: false },
    ]);
  });

  it('turns the pages of a file by the index they arrived under', () => {
    const turned = withFilePageTurns(listOf(), 'file-1', [0, 3, 0]);
    expect(turned.map((entry) => entry.turn)).toEqual([
      null,
      { quarterTurns: 3, mirrored: false },
      null,
      null,
    ]);
    // And null puts every page of that file back the way it arrived.
    expect(withFilePageTurns(turned, 'file-1', null).map((entry) => entry.turn)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('puts the pages of one file into the order asked for, in the places it already has', () => {
    const reordered = withFilePageOrder(listOf(), 'file-1', [2, 0, 1]);
    expect(reordered.map((entry) => entry.pageIndex)).toEqual([2, 0, 1, null]);
    // What was said about each page travels with it.
    const turned = withFilePageTurns(listOf(), 'file-1', [0, 0, 2]);
    expect(withFilePageOrder(turned, 'file-1', [2, 0, 1]).map((entry) => entry.turn)).toEqual([
      { quarterTurns: 2, mirrored: false },
      null,
      null,
      null,
    ]);
  });

  it('puts them back in the order they arrived when asked for none', () => {
    const shuffled = withFilePageOrder(listOf(), 'file-1', [2, 1, 0]);
    expect(withFilePageOrder(shuffled, 'file-1', null).map((entry) => entry.pageIndex)).toEqual([
      0,
      1,
      2,
      null,
    ]);
  });

  it('leaves the list alone for an order it cannot honour', () => {
    // A page this document does not hold, and a file it holds nothing of: the answer in both cases
    // is exactly the pages that were there.
    expect(
      withFilePageOrder(listOf(), 'file-1', [0, 1, 7]).map((entry) => entry.pageIndex),
    ).toEqual([0, 1, 2, null]);
    expect(withFilePageOrder(listOf(), 'file-3', [0]).length).toBe(4);
  });

  it('expands the entry standing for a file whole once its pages are counted', () => {
    const held = [
      page({
        position: 0,
        fileId: 'file-2',
        pageIndex: null,
        turn: { quarterTurns: 1, mirrored: false },
      }),
      page({ position: 1, fileId: 'file-3', pageIndex: null }),
    ];
    const expanded = withExpandedPages(held, new Map([['file-2', 3]]));
    expect(expanded.map((entry) => [entry.fileId, entry.pageIndex])).toEqual([
      ['file-2', 0],
      ['file-2', 1],
      ['file-2', 2],
      // Nothing counted this one, so it stands exactly as it was: a document is not made smaller by
      // a format we cannot read.
      ['file-3', null],
    ]);
    // What was said about the file whole is said about each of the pages it became, and the entry
    // that was there keeps its id.
    expect(expanded[0]?.id).toBe(held[0]?.id);
    expect(expanded[1]?.id).toBeUndefined();
    expect(expanded.slice(0, 3).map((entry) => entry.turn?.quarterTurns)).toEqual([1, 1, 1]);
  });

  it('knows when a rewrite would change nothing', () => {
    expect(samePages(listOf(), listOf())).toBe(true);
    expect(
      samePages(listOf(), withFileTurn(listOf(), 'file-1', { quarterTurns: 1, mirrored: false })),
    ).toBe(false);
    expect(samePages(listOf(), listOf().slice(1))).toBe(false);
    expect(samePages(listOf(), withFileCrop(listOf(), 'file-1', QUAD, 'AUTO'))).toBe(false);
  });
});
