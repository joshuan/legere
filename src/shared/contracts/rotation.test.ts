import { describe, expect, it } from 'vitest';
import {
  NO_ROTATION,
  isFileTurned,
  isIdentityRotation,
  turnedPoint,
  turnedQuad,
  turnedRotation,
  unturnedPoint,
  unturnedQuad,
  type Crop,
  type Rotation,
  type Turn,
} from './documents';

// Which way up the paper lay, as arithmetic (docs/03 §3.3.16). Two things have to hold and are easy
// to get wrong: pressing a button four times returns the page to where it started, and a mirror
// reverses which way "clockwise" runs — so a turn after a mirror has to be counted the other way or
// the picture and the stored value stop agreeing.

const press = (rotation: Rotation | null, ...turns: readonly Turn[]): Rotation =>
  turns.reduce<Rotation>((current, turn) => turnedRotation(current, turn), rotation ?? NO_ROTATION);

describe('turnedRotation', () => {
  it('comes back to where it started after four presses of the same button', () => {
    for (const turn of ['LEFT', 'RIGHT'] as const) {
      expect(press(null, turn, turn, turn, turn)).toEqual(NO_ROTATION);
    }
    // And a mirror is its own undoing.
    expect(press(null, 'MIRROR', 'MIRROR')).toEqual(NO_ROTATION);
  });

  it('takes one press left back where one press right had it', () => {
    expect(press(null, 'RIGHT')).toEqual({ quarterTurns: 1, mirrored: false });
    expect(press(null, 'RIGHT', 'LEFT')).toEqual(NO_ROTATION);
    expect(press(null, 'RIGHT', 'RIGHT')).toEqual({ quarterTurns: 2, mirrored: false });
    expect(press(null, 'LEFT')).toEqual({ quarterTurns: 3, mirrored: false });
  });

  it('turns the stored quarter turns round when the page is mirrored', () => {
    // 🔒 The one that is easy to get wrong: the stored value is "mirror first, then turn", so
    // mirroring a page that is already turned has to restate the turn from the other side. What the
    // person sees is the page they were looking at, flipped — nothing else moves.
    expect(press(null, 'RIGHT', 'MIRROR')).toEqual({ quarterTurns: 3, mirrored: true });
    expect(press(null, 'MIRROR', 'RIGHT')).toEqual({ quarterTurns: 1, mirrored: true });
  });

  it('reaches all eight ways a rectangle can lie, and no ninth', () => {
    const seen = new Set<string>();
    const walk = (rotation: Rotation, depth: number): void => {
      const key = `${rotation.quarterTurns}${rotation.mirrored ? 'm' : ''}`;
      if (seen.has(key) || depth > 4) return;
      seen.add(key);
      for (const turn of ['LEFT', 'RIGHT', 'MIRROR'] as const) {
        walk(turnedRotation(rotation, turn), depth + 1);
      }
    };
    walk(NO_ROTATION, 0);

    expect(seen.size).toBe(8);
  });
});

describe('isIdentityRotation', () => {
  it('reads a turn of nothing as the way the file arrived', () => {
    expect(isIdentityRotation(null)).toBe(true);
    expect(isIdentityRotation(NO_ROTATION)).toBe(true);
    expect(isIdentityRotation({ quarterTurns: 0, mirrored: true })).toBe(false);
    expect(isIdentityRotation({ quarterTurns: 2, mirrored: false })).toBe(false);
  });
});

describe('turnedPoint / unturnedPoint', () => {
  const CORNER: [number, number] = [0.1, 0.25];

  it('sends the top-left corner round the picture, a quarter at a time', () => {
    // Clockwise: a point near the top-left goes to the top-right, then the bottom-right, then the
    // bottom-left — which is what a page turning under a fixed frame does.
    expect(turnedPoint(CORNER, { quarterTurns: 1, mirrored: false })).toEqual([0.75, 0.1]);
    expect(turnedPoint(CORNER, { quarterTurns: 2, mirrored: false })).toEqual([0.9, 0.75]);
    expect(turnedPoint(CORNER, { quarterTurns: 3, mirrored: false })).toEqual([0.25, 0.9]);
  });

  it('reflects left to right for a mirror, and nothing at all for no turn', () => {
    expect(turnedPoint(CORNER, { quarterTurns: 0, mirrored: true })).toEqual([0.9, 0.25]);
    expect(turnedPoint(CORNER, null)).toEqual(CORNER);
  });

  it('undoes every one of the eight turns exactly', () => {
    for (const quarterTurns of [0, 1, 2, 3] as const) {
      for (const mirrored of [false, true]) {
        const rotation: Rotation = { quarterTurns, mirrored };
        const there = turnedPoint(CORNER, rotation);
        // 🔒 Exactly, to the number — not "close enough". This is what lets the editor draw the
        // page turned while the file keeps its crop against the pixels that arrived, without a
        // press of rotate-then-reset silently rewriting four corners nobody touched
        // (docs/11 §11.5c). In binary floating point `1 − (1 − 0.1)` is not 0.1.
        expect(unturnedPoint(there, rotation)).toEqual(CORNER);
      }
    }
  });

  it('brings a corner home after four turns of the picture, to the number', () => {
    let point: [number, number] = [...CORNER];
    for (const _quarter of [0, 1, 2, 3]) {
      point = turnedPoint(point, { quarterTurns: 1, mirrored: false });
    }
    expect(point).toEqual(CORNER);
  });
});

describe('turnedQuad / unturnedQuad', () => {
  // A photographed page, its four corners clockwise from the top-left of the picture that arrived.
  const QUAD: Crop['points'] = [
    [0.1, 0.05],
    [0.9, 0.08],
    [0.92, 0.95],
    [0.08, 0.9],
  ];

  it('renames the corners as well as moving them', () => {
    // 🔒 The bug this exists to make impossible: turn the page a quarter clockwise and the corner
    // that was top-left is the top-right one, so the list has to start from what was bottom-left.
    // Move the points without re-lettering them and the stored quad carries a second copy of the
    // turn into a build that is about to turn the page again (docs/11 §11.5c).
    expect(turnedQuad(QUAD, { quarterTurns: 1, mirrored: false })).toEqual([
      [0.1, 0.08],
      [0.95, 0.1],
      [0.92, 0.9],
      [0.05, 0.92],
    ]);
  });

  it('keeps the whole image the whole image, whichever way it is turned', () => {
    const full: Crop['points'] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const quarterTurns of [0, 1, 2, 3] as const) {
      for (const mirrored of [false, true]) {
        expect(turnedQuad(full, { quarterTurns, mirrored })).toEqual(full);
      }
    }
  });

  it('is undone exactly, for every one of the eight ways a page can lie', () => {
    for (const quarterTurns of [0, 1, 2, 3] as const) {
      for (const mirrored of [false, true]) {
        const rotation: Rotation = { quarterTurns, mirrored };
        expect(unturnedQuad(turnedQuad(QUAD, rotation), rotation)).toEqual(QUAD);
      }
    }
  });

  it('composes: turning twice by a quarter is turning once by a half', () => {
    // Which is what lets the editor apply one press at a time to what it is already holding and
    // still agree with the total turn it saves (docs/11 §11.5c).
    const quarter: Rotation = { quarterTurns: 1, mirrored: false };
    const once = turnedQuad(turnedQuad(QUAD, quarter), quarter);
    expect(once).toEqual(turnedQuad(QUAD, { quarterTurns: 2, mirrored: false }));
  });

  it('composes through a mirror the way the stored turn does', () => {
    // A page already turned a quarter, then flipped: the editor turns what it holds by the mirror
    // alone, and the stored value it sends is `turnedRotation(…, MIRROR)`. The two have to describe
    // the same picture, or a saved crop would land on the wrong part of the paper.
    const start: Rotation = { quarterTurns: 1, mirrored: false };
    const mirror: Rotation = { quarterTurns: 0, mirrored: true };
    const shown = turnedQuad(turnedQuad(QUAD, start), mirror);

    const total = turnedRotation(start, 'MIRROR');
    expect(shown).toEqual(turnedQuad(QUAD, total));
    expect(unturnedQuad(shown, total)).toEqual(QUAD);
  });
});

describe('isFileTurned', () => {
  const file = (
    rotation: Rotation | null,
    pageRotations: (0 | 1 | 2 | 3)[] | null,
  ): { rotation: Rotation | null; pageRotations: (0 | 1 | 2 | 3)[] | null } => ({
    rotation,
    pageRotations,
  });

  it('says nothing about a file that reads the way it arrived', () => {
    expect(isFileTurned(file(null, null))).toBe(false);
    // A turn pressed round in a circle, and a list in which nothing is turned: both are the way the
    // file arrived, whatever is written in the column (docs/11 §11.5a).
    expect(isFileTurned(file(NO_ROTATION, null))).toBe(false);
    expect(isFileTurned(file(null, [0, 0, 0]))).toBe(false);
  });

  it('says so for an image turned as one picture and for a PDF with a page on its side', () => {
    expect(isFileTurned(file({ quarterTurns: 1, mirrored: false }, null))).toBe(true);
    expect(isFileTurned(file({ quarterTurns: 0, mirrored: true }, null))).toBe(true);
    expect(isFileTurned(file(null, [0, 3, 0]))).toBe(true);
  });
});
