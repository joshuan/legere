import { NO_ROTATION, type Rotation } from '../../../shared/contracts/documents';

// The picture, drawn the way up it is going to be read (docs/11 §11.5c). Pure arithmetic over the
// image's own size and the turn stored beside it — no DOM — so what the editor lays out can be
// reasoned about in a place that lays nothing out.

export type Size = { width: number; height: number };

// Whether the turn swaps the sides of the picture. A half turn and a mirror do not; the two quarter
// turns do, and that is the whole of why a turned page needs a box of its own shape.
export function isQuarterTurned(rotation: Rotation | null): boolean {
  const turn = rotation ?? NO_ROTATION;
  return turn.quarterTurns === 1 || turn.quarterTurns === 3;
}

// The shape the picture presents once it has been turned: a portrait scan lying on its side is a
// landscape page, and the box that holds it — and the crop overlay stretched over that box — has to
// be that shape or the outline would sit beside the paper instead of on it.
export function shownSize(natural: Size, rotation: Rotation | null): Size {
  if (!isQuarterTurned(rotation)) return natural;
  return { width: natural.height, height: natural.width };
}

// The CSS that turns the image inside its box: the mirror first, left to right, then the quarter
// turns clockwise — the order the stored value is defined in (docs/03 §3.3.16). Read right to left,
// which is how the browser composes a transform list, that is exactly what it does.
export function turnTransform(rotation: Rotation | null): string {
  const turn = rotation ?? NO_ROTATION;
  const parts = ['translate(-50%, -50%)'];
  if (turn.quarterTurns !== 0) parts.push(`rotate(${turn.quarterTurns * 90}deg)`);
  if (turn.mirrored) parts.push('scaleX(-1)');
  return parts.join(' ');
}

// How large the picture may be drawn, said in CSS rather than measured in JavaScript: never wider
// than the space it is in, never larger than its own pixels, and never taller than the sixty per
// cent of the window §11.5c has always given it — that last one expressed as the width which
// produces exactly that height, because the box's height follows from its width and its shape.
export function shownWidth(natural: Size, rotation: Rotation | null, maxHeightVh = 60): string {
  const shown = shownSize(natural, rotation);
  const byHeight = (maxHeightVh * shown.width) / shown.height;
  return `min(100%, ${shown.width}px, ${round(byHeight)}vh)`;
}

// The image inside the box, in per cent of the box. Unturned it simply fills it; quarter-turned its
// width has to become the box's height and its height the box's width, and a percentage of the
// wrong axis is the only way to say that in CSS.
export function shownImageSize(natural: Size, rotation: Rotation | null): Size | null {
  const shown = shownSize(natural, rotation);
  if (shown.width <= 0 || shown.height <= 0) return null;
  if (!isQuarterTurned(rotation)) return { width: 100, height: 100 };
  return {
    width: round((100 * shown.height) / shown.width),
    height: round((100 * shown.width) / shown.height),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
