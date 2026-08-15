import type { Crop } from '../../../shared/contracts/documents';

// The loupe of docs/11 §11.5c, as arithmetic: how much it magnifies, which part of the source image
// is under it, and where it sits beside the corner. Nothing here touches the DOM — it works from
// what the editor already holds (the rendered frame, the image's own size, the corner being placed),
// which is what lets a loupe be reasoned about in an environment that lays nothing out.

// A corner of the crop, normalized 0…1 — the editor's coordinate model, which this file reads and
// never changes.
type CropPoint = Crop['points'][number];

// The same pair in pixels of something: the loupe's own box, here.
export type Point = [number, number];

export type Size = { width: number; height: number };

// The side of the square loupe, in CSS pixels: large enough to be read at a glance, small enough to
// stand beside a corner on a 14-inch screen without becoming the modal.
export const LOUPE_SIZE = 160;

// How far the loupe keeps from the corner, so the pointer placing it never sits on it.
export const LOUPE_GAP = 24;

export type LoupeView = {
  // Where the box sits, in CSS pixels from the image's top-left corner.
  left: number;
  top: number;
  // The side of the box, in CSS pixels.
  size: number;
  // CSS pixels of the box per source pixel. Never below 1: the modal scales the image down, the
  // loupe does not (docs/11 §11.5c).
  scale: number;
  // The square of the source image under the box, in source pixels.
  source: { left: number; top: number; size: number };
};

// How much of its own resolution the image kept on the way into the modal: the smaller ratio binds,
// because that is the one the max-width/max-height box fitted the image by.
export function frameScale(frame: Size, natural: Size): number {
  if (natural.width <= 0 || natural.height <= 0) return 0;
  return Math.min(frame.width / natural.width, frame.height / natural.height);
}

// Kept inside the image, which is what keeps the loupe inside the modal. A frame smaller than the
// loupe itself has no room to keep it out of: `Math.max(limit, 0)` then pins it at the top-left
// rather than pushing it off the other side.
function hold(value: number, limit: number): number {
  return Math.round(Math.min(Math.max(value, 0), Math.max(limit, 0)));
}

export function loupeView(
  point: CropPoint,
  frame: Size,
  natural: Size,
  size: number = LOUPE_SIZE,
  gap: number = LOUPE_GAP,
): LoupeView | null {
  const shown = frameScale(frame, natural);
  // No frame measured, or an image that has not said how large it is: there is nothing to magnify
  // and nothing to magnify it against.
  if (frame.width <= 0 || frame.height <= 0 || shown <= 0) return null;

  const scale = Math.max(1, shown);
  // How much of the source is under the box, in source pixels.
  const span = size / scale;
  const centre = { x: point[0] * natural.width, y: point[1] * natural.height };
  const corner = { x: point[0] * frame.width, y: point[1] * frame.height };

  // Above and to the right by preference, flipped across the corner when that edge of the image is
  // too close — either way the corner keeps a gap of clear pixels around it.
  const right = corner.x + gap;
  const above = corner.y - gap - size;
  const left = right + size <= frame.width ? right : corner.x - gap - size;
  const top = above >= 0 ? above : corner.y + gap;

  return {
    left: hold(left, frame.width - size),
    top: hold(top, frame.height - size),
    size,
    scale,
    source: { left: centre.x - span / 2, top: centre.y - span / 2, size: span },
  };
}

// A crop point in the loupe's own pixels: what the outline through it and the crosshair are drawn
// in. The centre of the box is the corner being placed, so the point being dragged lands on it.
export function loupePoint(point: CropPoint, natural: Size, view: LoupeView): Point {
  return [
    (point[0] * natural.width - view.source.left) * view.scale,
    (point[1] * natural.height - view.source.top) * view.scale,
  ];
}
