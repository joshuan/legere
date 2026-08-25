import { describe, expect, it } from 'vitest';
import {
  effectivePageOrder,
  effectivePageRotations,
  effectiveRotation,
  isPageRotationList,
} from './file';

// What the canonical build reads off a file before it opens Stirling at all (docs/05 §5.5 step 1
// and step 1.1): a turn worth applying, a list of page turns that describes the pages just counted,
// and nothing at all for a file that reads the way it arrived.

describe('effectiveRotation', () => {
  it('answers nothing for a file nobody has turned', () => {
    expect(effectiveRotation({ rotation: null })).toBeNull();
    // A turn of nothing is not worth re-encoding a page for: four presses of rotate-right leave a
    // stored value that says the picture arrived this way up.
    expect(effectiveRotation({ rotation: { quarterTurns: 0, mirrored: false } })).toBeNull();
  });

  it('answers the turn itself for a page somebody stood up', () => {
    const rotation = { quarterTurns: 3, mirrored: false } as const;
    expect(effectiveRotation({ rotation })).toEqual(rotation);
    expect(effectiveRotation({ rotation: { quarterTurns: 0, mirrored: true } })).toEqual({
      quarterTurns: 0,
      mirrored: true,
    });
  });
});

describe('isPageRotationList', () => {
  it('accepts one quarter turn for every page of the file, and nothing else', () => {
    expect(isPageRotationList([0, 1, 2], 3)).toBe(true);
    // Too short, too long, and a turn that is not a quarter of anything.
    expect(isPageRotationList([0, 1], 3)).toBe(false);
    expect(isPageRotationList([0, 1, 2, 3], 3)).toBe(false);
    expect(isPageRotationList([0, 4, 0], 3)).toBe(false);
    expect(isPageRotationList([0, -1, 0], 3)).toBe(false);
    expect(isPageRotationList([0, 1.5, 0], 3)).toBe(false);
  });
});

describe('effectivePageRotations', () => {
  it('answers nothing for a file whose pages all stand the way they arrived', () => {
    expect(effectivePageRotations({ pageRotations: null }, 3)).toBeNull();
    expect(effectivePageRotations({ pageRotations: [0, 0, 0] }, 3)).toBeNull();
  });

  it('answers the list for a file with a page on its side', () => {
    expect(effectivePageRotations({ pageRotations: [0, 1, 0] }, 3)).toEqual([0, 1, 0]);
  });

  it('ignores a list that does not describe the pages just counted', () => {
    // The document outranks the correction, exactly as it does for an unreadable crop and for an
    // order that no longer fits the file (docs/05 §5.5 step 1.1).
    expect(effectivePageRotations({ pageRotations: [0, 1, 0] }, 2)).toBeNull();
    expect(effectivePageOrder({ pageOrder: [2, 0, 1] }, 2)).toBeNull();
  });
});
