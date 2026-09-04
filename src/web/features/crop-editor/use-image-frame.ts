'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';

// Where the image actually ended up on the screen, in CSS pixels (docs/11 §11.5c). The crop itself
// is stored normalized, so this is needed for exactly two things: turning a pointer position into a
// fraction of the image, and knowing how much of the image one pixel of an arrow key is worth.
export type ImageFrame = { left: number; top: number; width: number; height: number };

// Nothing measured yet — an image that has not loaded, or a layout engine that does not exist
// (jsdom). Callers treat a zero-sized frame as "cannot convert" rather than dividing by it.
export const NO_FRAME: ImageFrame = { left: 0, top: 0, width: 0, height: 0 };

export type ImageFrameHandle = {
  frame: ImageFrame;
  // Re-read the element now: the image finished loading, or something moved it.
  measure: () => void;
};

function sameFrame(frame: ImageFrame, rect: DOMRect): boolean {
  return (
    frame.left === rect.left &&
    frame.top === rect.top &&
    frame.width === rect.width &&
    frame.height === rect.height
  );
}

// The one place the editor touches layout, and therefore the seam the tests drive: jsdom lays
// nothing out, so a component that read `getBoundingClientRect()` inline would be untestable.
export function useImageFrame(
  target: RefObject<HTMLImageElement | null>,
  active: boolean,
): ImageFrameHandle {
  const [frame, setFrame] = useState<ImageFrame>(NO_FRAME);

  const measure = useCallback((): void => {
    const element = target.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setFrame((current) =>
      sameFrame(current, rect)
        ? current
        : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    );
  }, [target]);

  useEffect(() => {
    // A closed dialog keeps the last frame rather than clearing it: nothing reads it meanwhile, and
    // the next opening measures again before anything can be converted through it.
    if (!active) return undefined;

    const initialMeasure = window.requestAnimationFrame(measure);
    const element = target.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return () => window.cancelAnimationFrame(initialMeasure);
    }

    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    // A resize changes the size, a scroll only the origin — both invalidate the conversion.
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);

    return () => {
      window.cancelAnimationFrame(initialMeasure);
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, measure, target]);

  return { frame, measure };
}
