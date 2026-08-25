'use client';

import { theme } from 'antd';
import { useEffect, useRef, type RefObject } from 'react';
import { NO_ROTATION, type Crop, type Rotation } from '../../../shared/contracts/documents';
import { loupePoint, loupeView, type Size } from './loupe-geometry';

// The loupe of docs/11 §11.5c: while a corner is being placed, the neighbourhood of that corner from
// the source image at no less than its own resolution, with the crop outline through it and a
// crosshair on the exact point. It draws from the very image element the editor already loaded —
// never a second request for the same bytes — and it says nothing, because a caption on a
// magnifying glass would be words at the one moment a person is looking at pixels.

type CropPoints = Crop['points'];

export type LoupeProps = {
  // The image the modal is showing. The loupe magnifies it; it never fetches it.
  image: RefObject<HTMLImageElement | null>;
  points: CropPoints;
  // The corner being placed — the one under the pointer, or the focused one being nudged.
  index: number;
  // Where the image ended up, in CSS pixels, and how large the page is once it has been turned —
  // sides swapped where the turn swaps them, because that is the picture the points are drawn in.
  frame: Size;
  natural: Size;
  // Which way up the page is being read. The magnified patch is turned with it, or the loupe would
  // show the one part of the modal that had not moved (docs/11 §11.5c).
  rotation?: Rotation | null;
};

export function Loupe({ image, points, index, frame, natural, rotation = null }: LoupeProps) {
  const { token } = theme.useToken();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const point = points[index];
  const view = point === undefined ? null : loupeView(point, frame, natural);

  // Primitives rather than the view object, so a re-render that changes nothing does not redraw.
  const size = view === null ? 0 : view.size;
  const sourceLeft = view === null ? 0 : view.source.left;
  const sourceTop = view === null ? 0 : view.source.top;
  const sourceSize = view === null ? 0 : view.source.size;
  const turn = rotation ?? NO_ROTATION;
  const quarterTurns = turn.quarterTurns;
  const mirrored = turn.mirrored;

  useEffect(() => {
    const canvas = canvasRef.current;
    const element = image.current;
    if (canvas === null || element === null || size <= 0 || sourceSize <= 0) return;

    const context = canvas.getContext('2d');
    // No 2D context — a browser that refused one, or a test environment without a canvas. The
    // outline and the crosshair are SVG and still say where the corner is.
    if (context === null) return;

    context.clearRect(0, 0, size, size);
    // A loupe over pixels shows pixels rather than a smooth guess about them.
    context.imageSmoothingEnabled = false;

    // The element holds the picture as it arrived; everything above is measured on the page as it is
    // being read. The canvas is therefore given the same turn the modal gives the image — mirror
    // first, then the quarter turns clockwise — after which the source rectangle can be asked for in
    // the coordinates the rest of this component speaks (docs/11 §11.5c).
    context.save();
    context.scale(size / sourceSize, size / sourceSize);
    context.translate(-sourceLeft, -sourceTop);
    const width = element.naturalWidth;
    const height = element.naturalHeight;
    if (quarterTurns === 1) {
      context.translate(height, 0);
      context.rotate(Math.PI / 2);
    } else if (quarterTurns === 2) {
      context.translate(width, height);
      context.rotate(Math.PI);
    } else if (quarterTurns === 3) {
      context.translate(0, width);
      context.rotate(-Math.PI / 2);
    }
    if (mirrored) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(element, 0, 0);
    context.restore();
  }, [image, size, sourceLeft, sourceTop, sourceSize, quarterTurns, mirrored]);

  if (point === undefined || view === null) return null;

  const corners = points.map((corner) => {
    const [x, y] = loupePoint(corner, natural, view);
    return `${x},${y}`;
  });
  const outside = `M0,0 H${size} V${size} H0 Z M${corners.join(' L')} Z`;
  const middle = size / 2;
  const arm = size / 6;

  return (
    <div
      data-testid="crop-loupe"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: view.left,
        top: view.top,
        width: size,
        height: size,
        overflow: 'hidden',
        borderRadius: token.borderRadiusLG,
        border: `2px solid ${token.colorWhite}`,
        boxShadow: token.boxShadow,
        background: token.colorBgLayout,
        // The corner is dragged through the place the loupe stands in.
        pointerEvents: 'none',
        lineHeight: 0,
      }}
    >
      <canvas ref={canvasRef} width={size} height={size} style={{ display: 'block' }} />

      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        style={{ position: 'absolute', left: 0, top: 0 }}
      >
        {/* The same dimming the modal draws, at the same edges, so the two read as one picture. */}
        <path d={outside} fillRule="evenodd" fill="rgba(0, 0, 0, 0.45)" />
        <polygon
          data-testid="crop-loupe-outline"
          points={corners.join(' ')}
          fill="none"
          stroke={token.colorWhite}
          strokeWidth={1.5}
        />
        {/* The exact point, which is the centre of the box by construction. */}
        <g data-testid="crop-loupe-crosshair" stroke={token.colorPrimary} strokeWidth={1.5}>
          <line x1={middle - arm} y1={middle} x2={middle + arm} y2={middle} />
          <line x1={middle} y1={middle - arm} x2={middle} y2={middle + arm} />
        </g>
      </svg>
    </div>
  );
}
