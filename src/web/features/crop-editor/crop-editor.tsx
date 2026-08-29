'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Modal, Space, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  isIdentityRotation,
  turnedQuad,
  turnedRotation,
  unturnedQuad,
  type Crop,
  type DocumentFileDto,
  type DocumentPageDto,
  type Rotation,
  type Turn,
} from '../../../shared/contracts/documents';
import type { CropSuggestionResponse } from '../../../shared/contracts/files';
import { documentApi, documentFiles } from '../../entities/document';
import { useErrorMessage } from '../../shared/lib';
import { cropApi } from './api';
import { Loupe } from './loupe';
import { shownImageSize, shownSize, shownWidth, turnTransform } from './turn-layout';
import { useImageFrame } from './use-image-frame';

// The crop editor of docs/11 §11.5c: the image at the largest size that fits, four corners joined by
// a polygon, everything outside it dimmed. A quadrilateral rather than a rectangle, because a page
// photographed at an angle is not a rectangle (docs/05 §5.6).

export type CropPoints = Crop['points'];
export type CropPoint = CropPoints[number];

// The whole image: what "no crop" looks like in the editor, and where Clear puts it back to.
const FULL_FRAME: CropPoints = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

// Clockwise from the top-left (docs/05 §5.6) — the order the contract fixes, used for React keys so
// they say which corner they are.
const CORNER_KEYS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

// One press of a button, as a turn of the page in front of the person pressing it. Applied to the
// points the editor is holding, which is what keeps a corner on the bit of paper it was put on
// (docs/11 §11.5c).
const GESTURES: Record<Turn, Rotation> = {
  LEFT: { quarterTurns: 3, mirrored: false },
  RIGHT: { quarterTurns: 1, mirrored: false },
  MIRROR: { quarterTurns: 0, mirrored: true },
};

// The last two pixels of a corner are not a mouse gesture (docs/11 §11.5c).
const ARROW_STEPS: Record<string, CropPoint | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const NUDGE_PIXELS = 1;
const NUDGE_PIXELS_FAST = 10;

const HANDLE_SIZE = 18;

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// One corner replaced, the tuple kept a tuple: the contract is four points, not "some points".
function withPoint(points: CropPoints, index: number, point: CropPoint): CropPoints {
  return [
    index === 0 ? point : points[0],
    index === 1 ? point : points[1],
    index === 2 ? point : points[2],
    index === 3 ? point : points[3],
  ];
}

// Normalized 0…1 → the overlay's own 0…100 viewBox. Rounded, because 0.1 × 100 is not 10 in
// binary floating point and an SVG attribute should not say so.
function percent(value: number): number {
  return Math.round(value * 100_000) / 1000;
}

export type CropEditorProps = {
  open: boolean;
  documentId: string;
  // What is being cropped: **one page** of the document (docs/03 §3.3.17). The file beside it is
  // where the picture comes from and what decides whether a mirror is on offer.
  page: DocumentPageDto;
  file: DocumentFileDto;
  // What the edit landing costs the screen around it — the document is rebuilding, so its text, its
  // journal and every list it appears in are stale. Told apart from `onClose` on purpose: closing
  // an editor nobody saved changed nothing, and re-reading a whole document for an abandoned edit
  // is a request that says nothing.
  onSaved?: () => void;
  onClose: () => void;
};

export function CropEditor({ open, documentId, page, file, onSaved, onClose }: CropEditorProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const imageRef = useRef<HTMLImageElement>(null);
  const { frame, measure } = useImageFrame(imageRef, open);

  // 🔒 The points are in the orientation on the screen, not the one the file is stored in: a corner
  // is dragged onto the page a person is looking at. They are turned back on the way out, because
  // the build applies the crop first and the turn after it (docs/05 §5.6).
  const [points, setPoints] = useState<CropPoints>(FULL_FRAME);
  // Whether Save means "clear this crop". A file that arrives without one starts here, so opening
  // the editor and saving it untouched is the no-op it looks like rather than a full-frame crop.
  const [cleared, setCleared] = useState(true);
  // Which way up the page is being read. Sent with the crop — one edit, one rebuild.
  const [rotation, setRotation] = useState<Rotation | null>(null);
  const [proposal, setProposal] = useState<CropSuggestionResponse['method'] | null>(null);
  const dragging = useRef<number | null>(null);

  // What the loupe is watching, and what it magnifies against (docs/11 §11.5c). The corner is state
  // rather than the drag ref because a loupe that appears has to be rendered; the image's own size
  // is read off the element the modal already loaded, so nothing is fetched twice.
  const [watched, setWatched] = useState<number | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const readNatural = useCallback((): void => {
    const element = imageRef.current;
    if (element === null) return;
    setNatural((current) =>
      current.width === element.naturalWidth && current.height === element.naturalHeight
        ? current
        : { width: element.naturalWidth, height: element.naturalHeight },
    );
  }, []);

  // The image landed: where it landed, and how much of itself it had to give up to land there.
  const handleLoad = useCallback((): void => {
    measure();
    readNatural();
  }, [measure, readNatural]);

  // A corner is being placed. The size is re-read here too, because an image cached by the browser
  // can be complete before this modal ever attached an onLoad to it.
  const watch = useCallback(
    (index: number): void => {
      readNatural();
      setWatched(index);
    },
    [readNatural],
  );

  const unwatch = useCallback((index: number): void => {
    setWatched((current) => (current === index ? null : current));
  }, []);

  // Opening on a page that already has a crop starts from it; one without starts from the whole
  // image. Adjusted during render rather than in an effect, so the first frame anybody sees is
  // already the right quadrilateral. Keyed by the page, so a background refetch of the document
  // cannot wipe out corners somebody is in the middle of dragging.
  const [editing, setEditing] = useState<string | null>(null);
  if (open && editing !== page.id) {
    setEditing(page.id);
    // Turned on the way in: what is stored is against the pixels that arrived, and what is drawn is
    // the page as it will be read (docs/11 §11.5c).
    setPoints(page.crop === null ? FULL_FRAME : turnedQuad(page.crop.points, page.turn));
    setCleared(page.crop === null);
    setRotation(page.turn);
    setProposal(null);
  }
  if (!open && editing !== null) {
    // Only the marker: a closing modal should fade out showing what it had, and the next open
    // re-reads the file anyway.
    setEditing(null);
  }

  const moveTo = useCallback((index: number, x: number, y: number): void => {
    setPoints((current) => withPoint(current, index, [clamp(x), clamp(y)]));
    setCleared(false);
  }, []);

  const nudgeBy = useCallback((index: number, dx: number, dy: number): void => {
    setPoints((current) => {
      const point = current[index];
      if (point === undefined) return current;
      return withPoint(current, index, [clamp(point[0] + dx), clamp(point[1] + dy)]);
    });
    setCleared(false);
  }, []);

  const suggest = useMutation({
    mutationFn: () => cropApi.suggestion(documentId, file.id),
    // A proposal, dropped into the editor for the person to accept or drag. It never saves by
    // itself (docs/11 §11.5c). The server found the page in the pixels that arrived, so the answer
    // is turned into the orientation on the screen like a stored crop.
    onSuccess: (result) => {
      setPoints(turnedQuad(result.crop.points, rotation));
      setCleared(false);
      setProposal(result.method);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const save = useMutation({
    mutationFn: () =>
      documentApi.updatePage(documentId, page.id, {
        // Turned back on the way out, and both in one request: the crop and the turn are one edit
        // of one page and therefore one rebuild (docs/07 §7.3).
        crop: cleared ? null : { points: unturnedQuad(points, rotation) },
        turn: isIdentityRotation(rotation) ? null : rotation,
      }),
    onSuccess: () => {
      // The document is rebuilding, and it can appear in any list — hence the shared prefix.
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void message.success(t('viewer.crop.saved'));
      onSaved?.();
      onClose();
    },
    // The modal closes on the answer, not on the click, so a failure is visible where it happened.
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const clearCrop = (): void => {
    setPoints(FULL_FRAME);
    setCleared(true);
    setProposal(null);
  };

  // One press of rotate or mirror: the page in front of the person turns, and the quadrilateral
  // turns with it, so a corner stays on the bit of paper it was put on (docs/11 §11.5c).
  const turn = (gesture: Turn): void => {
    setPoints((current) => turnedQuad(current, GESTURES[gesture]));
    setRotation((current) => turnedRotation(current, gesture));
  };

  // The sibling of Clear crop: the file reads the way up it arrived, and the points come back out of
  // the orientation they were turned into (docs/11 §11.5c).
  const resetTurn = (): void => {
    setPoints((current) => unturnedQuad(current, rotation));
    setRotation(null);
  };

  const startDrag =
    (index: number) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      dragging.current = index;
      watch(index);
      const handle = event.currentTarget;
      // Capture keeps the corner following a pointer that has left the handle — and not every
      // environment the tests run in implements it.
      if (typeof handle.setPointerCapture === 'function') handle.setPointerCapture(event.pointerId);
    };

  const drag =
    (index: number) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (dragging.current !== index) return;
      if (frame.width <= 0 || frame.height <= 0) return;
      moveTo(
        index,
        (event.clientX - frame.left) / frame.width,
        (event.clientY - frame.top) / frame.height,
      );
    };

  const endDrag =
    (index: number) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (dragging.current !== index) return;
      dragging.current = null;
      // The corner has been let go, and the loupe goes with it (docs/11 §11.5c).
      unwatch(index);
      const handle = event.currentTarget;
      if (
        typeof handle.hasPointerCapture === 'function' &&
        typeof handle.releasePointerCapture === 'function' &&
        handle.hasPointerCapture(event.pointerId)
      ) {
        handle.releasePointerCapture(event.pointerId);
      }
    };

  const nudge =
    (index: number) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const direction = ARROW_STEPS[event.key];
      if (direction === undefined) return;
      // An arrow key inside a dialog otherwise scrolls it out from under the corner.
      event.preventDefault();
      // The arrow keys are exactly the moment one pixel matters, so the loupe comes out for them
      // too — and stays until the handle is left (docs/11 §11.5c).
      watch(index);
      if (frame.width <= 0 || frame.height <= 0) return;
      const pixels = event.shiftKey ? NUDGE_PIXELS_FAST : NUDGE_PIXELS;
      nudgeBy(index, (direction[0] * pixels) / frame.width, (direction[1] * pixels) / frame.height);
    };

  // The overlay is drawn in its own 0…100 box stretched over the image, so a resized window moves
  // nothing: the state stays normalized and the browser does the arithmetic.
  const corners = points.map(([x, y]) => `${percent(x)},${percent(y)}`);
  const outside = `M0,0 H100 V100 H0 Z M${corners.join(' L')} Z`;

  // The page as it will be read: the picture's own size with the sides swapped where the turn swaps
  // them, which is what the box, the overlay and the loupe are all measured in (docs/11 §11.5c).
  const shown = shownSize(natural, rotation);
  const shownImage = shownImageSize(natural, rotation);

  // What the corners are dragged over. A photograph is its own bytes at their own resolution; a page
  // of a PDF is the small JPG the page-thumb route renders (docs/07 §7.3), which is the only picture
  // of one page there is. The crop is stored normalized to 0…1, so a scaled picture places a corner
  // exactly where a full-size one would — what a smaller picture costs is what the loupe can
  // magnify, and it says so below rather than pretending otherwise.
  const pictureUrl =
    file.isImage || page.pageIndex === null
      ? cropApi.contentUrl(documentId, file.id)
      : documentFiles.pageThumb(documentId, file.id, page.pageIndex);

  return (
    <Modal
      open={open}
      title={t('viewer.crop.title')}
      onCancel={onClose}
      width={860}
      maskClosable={!save.isPending}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={save.isPending}>
          {t('viewer.crop.cancel')}
        </Button>,
        <Button key="save" type="primary" loading={save.isPending} onClick={() => save.mutate()}>
          {t('viewer.crop.save')}
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          {/* 🔒 Only for an image: the detector reads a photograph of a page, and the endpoint
              refuses anything else (docs/05 §5.6). A button that only ever failed would be worse
              than no button. */}
          {file.isImage && (
            <Button loading={suggest.isPending} onClick={() => suggest.mutate()}>
              {t('viewer.crop.autoDetect')}
            </Button>
          )}
          {/* Which way up the paper lay — one press, a quarter turn, and the page in front of the
              person turns with it (docs/11 §11.5c). Buttons like everything else here, and reached
              with the keyboard like everything else here. Named in words rather than drawn as
              arrows: an icon beside a label is a second name for one control, and a screen reader
              would read both. */}
          <Button onClick={() => turn('LEFT')}>{t('viewer.crop.rotateLeft')}</Button>
          <Button onClick={() => turn('RIGHT')}>{t('viewer.crop.rotateRight')}</Button>
          {/* 🔒 A mirror is a photograph's question. A PDF page arrives the way its producer laid
              it out, so it turns in quarters and is never reflected (docs/11 §11.5c). */}
          {file.isImage && (
            <Button onClick={() => turn('MIRROR')}>{t('viewer.crop.mirror')}</Button>
          )}
          <Button onClick={clearCrop}>{t('viewer.crop.reset')}</Button>
          <Button disabled={isIdentityRotation(rotation)} onClick={resetTurn}>
            {t('viewer.crop.resetTurn')}
          </Button>
        </Space>

        {proposal !== null && (
          <Alert
            showIcon
            type={proposal === 'EDGES' ? 'info' : 'warning'}
            message={
              proposal === 'EDGES' ? t('viewer.crop.autoDetected') : t('viewer.crop.autoFailed')
            }
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div
            style={{
              position: 'relative',
              display: 'inline-block',
              lineHeight: 0,
              maxWidth: '100%',
              userSelect: 'none',
              touchAction: 'none',
              // The box is the page as it will be read, so the overlay stretched over it lands on
              // the paper rather than beside it (docs/11 §11.5c). Until the image has said how large
              // it is there is nothing to shape it by, and it lays out the way it always has.
              ...(shownImage === null
                ? {}
                : {
                    width: shownWidth(natural, rotation),
                    aspectRatio: `${shown.width} / ${shown.height}`,
                  }),
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- an API route that streams the
                original or 302s to a signed URL (docs/10 §10.8). */}
            <img
              ref={imageRef}
              src={pictureUrl}
              alt={file.name}
              draggable={false}
              onLoad={handleLoad}
              style={
                shownImage === null
                  ? { display: 'block', maxWidth: '100%', maxHeight: '60vh' }
                  : {
                      display: 'block',
                      position: 'absolute',
                      left: '50%',
                      top: '50%',
                      // Quarter-turned, the picture's width is the box's height and the other way
                      // round — which a percentage of the box says exactly, and no measurement has
                      // to be taken to find out.
                      width: `${shownImage.width}%`,
                      height: `${shownImage.height}%`,
                      transform: turnTransform(rotation),
                    }
              }
            />

            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
              }}
            >
              {/* Everything but the quadrilateral, dimmed: one path, two subpaths, even-odd. */}
              <path d={outside} fillRule="evenodd" fill="rgba(0, 0, 0, 0.45)" />
              <polygon
                data-testid="crop-outline"
                points={corners.join(' ')}
                fill="none"
                stroke={token.colorWhite}
                strokeWidth={1.5}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            </svg>

            {points.map(([x, y], index) => (
              <button
                key={CORNER_KEYS[index]}
                type="button"
                aria-label={t('viewer.crop.corner', { index: index + 1 })}
                onPointerDown={startDrag(index)}
                onPointerMove={drag(index)}
                onPointerUp={endDrag(index)}
                onPointerCancel={endDrag(index)}
                onKeyDown={nudge(index)}
                onBlur={() => unwatch(index)}
                style={{
                  position: 'absolute',
                  left: `${percent(x)}%`,
                  top: `${percent(y)}%`,
                  width: HANDLE_SIZE,
                  height: HANDLE_SIZE,
                  marginLeft: -HANDLE_SIZE / 2,
                  marginTop: -HANDLE_SIZE / 2,
                  padding: 0,
                  borderRadius: '50%',
                  border: `2px solid ${token.colorWhite}`,
                  background: token.colorPrimary,
                  boxShadow: token.boxShadowSecondary,
                  cursor: 'grab',
                  touchAction: 'none',
                }}
              />
            ))}

            {/* Beside the corner being placed, inside the image, gone when it is let go — and in
                the page's current orientation, because a magnified patch of a page that has since
                moved is a patch of the wrong paper (docs/11 §11.5c). */}
            {watched !== null && (
              <Loupe
                image={imageRef}
                points={points}
                index={watched}
                frame={frame}
                natural={shown}
                rotation={rotation}
              />
            )}
          </div>
        </div>

        {/* What the result will be, rather than a preview pretending to render it (docs/11 §11.5c). */}
        <Typography.Text type="secondary">{t('viewer.crop.hint')}</Typography.Text>
        {/* And, for a page of a PDF, what the picture under the corners actually is: the page as the
            thumbnail route renders it, which is smaller than the page itself. */}
        {!file.isImage && (
          <Typography.Text type="secondary">{t('viewer.crop.pageHint')}</Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
