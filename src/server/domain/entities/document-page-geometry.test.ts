import { describe, expect, it } from 'vitest';
import { isSheetShaped, pageGeometryOf } from './document-page-geometry';

// The four shapes an archive actually meets (docs/05 §5.5 step 1).
const A4_PORTRAIT = { width: 2480, height: 3508 };
const A4_LANDSCAPE = { width: 2810, height: 1987 };
const RECEIPT = { width: 900, height: 2600 };
const SQUARE = { width: 2000, height: 2000 };

describe('isSheetShaped', () => {
  it('holds the A series in both orientations', () => {
    expect(isSheetShaped(A4_PORTRAIT)).toBe(true);
    expect(isSheetShaped(A4_LANDSCAPE)).toBe(true);
    // A5 and A3 are the same ratio; a sheet is a sheet whatever size it was cut to.
    expect(isSheetShaped({ width: 1748, height: 2480 })).toBe(true);
  });

  it('holds what a camera produces when somebody photographs a page edge to edge', () => {
    expect(isSheetShaped({ width: 4000, height: 3000 })).toBe(true);
    expect(isSheetShaped({ width: 3000, height: 2000 })).toBe(true);
  });

  it('does not hold the shapes that are not sheets', () => {
    expect(isSheetShaped(RECEIPT)).toBe(false);
    expect(isSheetShaped(SQUARE)).toBe(false);
    // A panorama is the extreme of the same mistake: on A4 it is a line across an empty page.
    expect(isSheetShaped({ width: 6000, height: 1000 })).toBe(false);
  });

  it('does not divide by zero on a picture that reports no size', () => {
    expect(isSheetShaped({ width: 0, height: 0 })).toBe(false);
  });
});

describe('pageGeometryOf', () => {
  it('gives a sheet A4 in the orientation it was photographed in', () => {
    expect(pageGeometryOf([A4_PORTRAIT], 'AUTO')).toEqual({
      pageSize: 'A4',
      orientation: 'PORTRAIT',
    });
    // The whole point of the exercise: a landscape photograph on a portrait sheet is half white
    // margin, and that margin is what the recognizer reads instead of the document.
    expect(pageGeometryOf([A4_LANDSCAPE], 'AUTO')).toEqual({
      pageSize: 'A4',
      orientation: 'LANDSCAPE',
    });
  });

  it('leaves the shapes that are not sheets alone', () => {
    expect(pageGeometryOf([RECEIPT], 'AUTO').pageSize).toBeNull();
    expect(pageGeometryOf([SQUARE], 'AUTO').pageSize).toBeNull();
  });

  it('reads mixed shapes as not a sheet, because normalising them would letterbox one of them', () => {
    expect(pageGeometryOf([A4_PORTRAIT, RECEIPT], 'AUTO').pageSize).toBeNull();
  });

  it('normalises only when every page agrees on which way up it is', () => {
    expect(pageGeometryOf([A4_PORTRAIT, A4_LANDSCAPE], 'AUTO')).toEqual({
      pageSize: 'A4',
      orientation: 'PORTRAIT',
    });
  });

  it('leaves a document nothing was photographed for as it was laid out', () => {
    // Only PDFs and office files: those pages were laid out by whoever produced them, and A4 is a
    // guess about somebody else's document.
    expect(pageGeometryOf([], 'AUTO').pageSize).toBeNull();
  });

  it('obeys a person over the shapes', () => {
    expect(pageGeometryOf([RECEIPT], 'A4')).toEqual({ pageSize: 'A4', orientation: 'PORTRAIT' });
    expect(pageGeometryOf([A4_PORTRAIT], 'MATCH_SOURCE').pageSize).toBeNull();
  });
});
