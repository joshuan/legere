import { describe, expect, it } from 'vitest';
import {
  isQuarterTurned,
  shownImageSize,
  shownSize,
  shownWidth,
  turnTransform,
} from './turn-layout';

// The picture, drawn the way up it is going to be read (docs/11 §11.5c). The overlay is stretched
// over the box, so a box of the wrong shape puts the crop outline beside the paper instead of on it
// — which is the whole reason this arithmetic exists apart from the component.

const PORTRAIT = { width: 2480, height: 3508 };

describe('shownSize', () => {
  it('swaps the sides for a quarter turn and leaves them for the rest', () => {
    expect(shownSize(PORTRAIT, { quarterTurns: 1, mirrored: false })).toEqual({
      width: 3508,
      height: 2480,
    });
    expect(shownSize(PORTRAIT, { quarterTurns: 3, mirrored: true })).toEqual({
      width: 3508,
      height: 2480,
    });
    // A half turn and a mirror keep a portrait page portrait.
    expect(shownSize(PORTRAIT, { quarterTurns: 2, mirrored: false })).toEqual(PORTRAIT);
    expect(shownSize(PORTRAIT, { quarterTurns: 0, mirrored: true })).toEqual(PORTRAIT);
    expect(shownSize(PORTRAIT, null)).toEqual(PORTRAIT);
  });

  it('says which turns swap them', () => {
    expect(isQuarterTurned(null)).toBe(false);
    expect(isQuarterTurned({ quarterTurns: 1, mirrored: false })).toBe(true);
    expect(isQuarterTurned({ quarterTurns: 2, mirrored: true })).toBe(false);
    expect(isQuarterTurned({ quarterTurns: 3, mirrored: false })).toBe(true);
  });
});

describe('turnTransform', () => {
  it('mirrors first and turns after, which is the order the stored value is defined in', () => {
    // A CSS transform list is applied right to left, so the mirror written last runs first.
    expect(turnTransform({ quarterTurns: 1, mirrored: true })).toBe(
      'translate(-50%, -50%) rotate(90deg) scaleX(-1)',
    );
    expect(turnTransform({ quarterTurns: 3, mirrored: false })).toBe(
      'translate(-50%, -50%) rotate(270deg)',
    );
    // A file nobody has turned is centred and nothing else.
    expect(turnTransform(null)).toBe('translate(-50%, -50%)');
  });
});

describe('shownWidth', () => {
  it('bounds the picture by the room, by its own pixels and by the height it has always had', () => {
    // A portrait page: 60vh of height is 60 × (2480 / 3508) of width.
    expect(shownWidth(PORTRAIT, null)).toBe('min(100%, 2480px, 42.417vh)');
    // Turned, the same picture is wider than it is tall, so the height stops binding so soon.
    expect(shownWidth(PORTRAIT, { quarterTurns: 1, mirrored: false })).toBe(
      'min(100%, 3508px, 84.871vh)',
    );
  });
});

describe('shownImageSize', () => {
  it('fills the box when the sides did not swap', () => {
    expect(shownImageSize(PORTRAIT, null)).toEqual({ width: 100, height: 100 });
    expect(shownImageSize(PORTRAIT, { quarterTurns: 2, mirrored: true })).toEqual({
      width: 100,
      height: 100,
    });
  });

  it('makes the picture as wide as the box is tall when they did', () => {
    // 🔒 The picture inside a quarter-turned box has to be the box's *other* side long, and a
    // percentage of the wrong axis is the only way to say that in CSS without measuring anything.
    expect(shownImageSize(PORTRAIT, { quarterTurns: 1, mirrored: false })).toEqual({
      width: 70.696,
      height: 141.452,
    });
  });

  it('answers nothing for a picture that has not said how large it is', () => {
    // jsdom, or an image that has not loaded: there is nothing to shape the box by, and the editor
    // lays the picture out the way it always has.
    expect(shownImageSize({ width: 0, height: 0 }, null)).toBeNull();
  });
});
