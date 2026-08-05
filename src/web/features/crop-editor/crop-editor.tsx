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
import type { Crop, DocumentFileDto } from '../../../shared/contracts/documents';
import type { CropSuggestionResponse } from '../../../shared/contracts/files';
import { useErrorMessage } from '../../shared/lib';
import { cropApi } from './api';
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
  file: DocumentFileDto;
  onClose: () => void;
};

export function CropEditor({ open, documentId, file, onClose }: CropEditorProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const imageRef = useRef<HTMLImageElement>(null);
  const { frame, measure } = useImageFrame(imageRef, open);

  const [points, setPoints] = useState<CropPoints>(FULL_FRAME);
  // Whether Save means "clear this crop". A file that arrives without one starts here, so opening
  // the editor and saving it untouched is the no-op it looks like rather than a full-frame crop.
  const [cleared, setCleared] = useState(true);
  const [proposal, setProposal] = useState<CropSuggestionResponse['method'] | null>(null);
  const dragging = useRef<number | null>(null);

  // Opening on a file that already has a crop starts from it; one without starts from the whole
  // image. Adjusted during render rather than in an effect, so the first frame anybody sees is
  // already the right quadrilateral. Keyed by the file, so a background refetch of the document
  // cannot wipe out corners somebody is in the middle of dragging.
  const [editing, setEditing] = useState<string | null>(null);
  if (open && editing !== file.id) {
    setEditing(file.id);
    setPoints(file.crop === null ? FULL_FRAME : file.crop.points);
    setCleared(file.crop === null);
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
    // itself (docs/11 §11.5c).
    onSuccess: (result) => {
      setPoints(result.crop.points);
      setCleared(false);
      setProposal(result.method);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const save = useMutation({
    mutationFn: () => cropApi.save(documentId, file.id, { crop: cleared ? null : { points } }),
    onSuccess: () => {
      // The document is rebuilding, and it can appear in any list — hence the shared prefix.
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void message.success(t('viewer.crop.saved'));
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

  const startDrag =
    (index: number) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      dragging.current = index;
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
      if (frame.width <= 0 || frame.height <= 0) return;
      const pixels = event.shiftKey ? NUDGE_PIXELS_FAST : NUDGE_PIXELS;
      nudgeBy(index, (direction[0] * pixels) / frame.width, (direction[1] * pixels) / frame.height);
    };

  // The overlay is drawn in its own 0…100 box stretched over the image, so a resized window moves
  // nothing: the state stays normalized and the browser does the arithmetic.
  const corners = points.map(([x, y]) => `${percent(x)},${percent(y)}`);
  const outside = `M0,0 H100 V100 H0 Z M${corners.join(' L')} Z`;

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
          <Button loading={suggest.isPending} onClick={() => suggest.mutate()}>
            {t('viewer.crop.autoDetect')}
          </Button>
          <Button onClick={clearCrop}>{t('viewer.crop.reset')}</Button>
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
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- an API route that streams the
                original or 302s to a signed URL (docs/10 §10.8). */}
            <img
              ref={imageRef}
              src={cropApi.contentUrl(documentId, file.id)}
              alt={file.name}
              draggable={false}
              onLoad={measure}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh' }}
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
          </div>
        </div>

        {/* What the result will be, rather than a preview pretending to render it (docs/11 §11.5c). */}
        <Typography.Text type="secondary">{t('viewer.crop.hint')}</Typography.Text>
      </Space>
    </Modal>
  );
}
