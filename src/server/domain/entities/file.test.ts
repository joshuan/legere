import { describe, expect, it } from 'vitest';
import { isPagePermutation, isPageRotationList } from './file';

// What a file still answers about itself now that a crop, a turn and a page order belong to a page
// of a document rather than to the bytes (ADR-025): how many pages are inside it, and therefore
// whether a list somebody sent describes them.

describe('isPagePermutation', () => {
  it('accepts every page of the file named once, and nothing else', () => {
    expect(isPagePermutation([2, 0, 1], 3)).toBe(true);
    expect(isPagePermutation([0, 1], 3)).toBe(false);
    expect(isPagePermutation([0, 1, 1], 3)).toBe(false);
    expect(isPagePermutation([0, 1, 3], 3)).toBe(false);
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
