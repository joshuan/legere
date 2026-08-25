'use client';

import { RotateLeftOutlined, RotateRightOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Space, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { DocumentFileDto, PageRotations } from '../../../shared/contracts/documents';
import type { UpdateDocumentFileRequest } from '../../../shared/contracts/files';
import { useErrorMessage } from '../../shared/lib';
import { pageApi } from './api';
import {
  hasArrangeablePages,
  movePage,
  naturalOrder,
  noTurns,
  sameOrder,
  sameTurns,
  turnPage,
} from './page-order';

// The page strip of docs/11 §11.5a: the pages of one file, numbered, in the order they are read, put
// into the order the paper meant. The order lives here until it is saved — nothing is sent while a
// page is being moved — and what goes out is the whole permutation, the way a file reorder sends the
// whole order (docs/07 §7.3).

// One position at a time, in whichever direction the strip is being read: it wraps, so up is left
// and down is right. 🔒 The arrow keys are not a convenience — a hit area only a mouse can use is
// half a fix (docs/11 §11.3, §11.5a).
const ARROW_STEPS: Record<string, number | undefined> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

const TILE_WIDTH = 76;
const TILE_HEIGHT = 100;

export type PageArrangerProps = {
  documentId: string;
  file: DocumentFileDto;
};

export function PageArranger({ documentId, file }: PageArrangerProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const pageCount = file.pageCount ?? 0;
  // What the file says today: its stored order, or the one it arrived in where none is stored
  // (docs/03 §3.3.16).
  const stored = useMemo(
    () => file.pageOrder ?? naturalOrder(pageCount),
    [file.pageOrder, pageCount],
  );

  // And which way up each of them lies, indexed by the page's own number the way the order names
  // its pages (docs/03 §3.3.16).
  const storedTurns = useMemo(
    () => file.pageRotations ?? noTurns(pageCount),
    [file.pageRotations, pageCount],
  );

  const [order, setOrder] = useState<number[]>(stored);
  const [turns, setTurns] = useState<number[]>(storedTurns);
  // Keyed by the file, exactly as the crop editor is: a background refetch of the document must not
  // wipe out an order somebody is in the middle of arranging.
  const [arranging, setArranging] = useState<string | null>(null);
  if (arranging !== file.id) {
    setArranging(file.id);
    setOrder(stored);
    setTurns(storedTurns);
  }

  // The tiles, by the page they show, so a drag can ask which one a pointer is over and a keyboard
  // move can give the page its focus back afterwards.
  const tiles = useRef(new Map<number, HTMLButtonElement>());
  const dragging = useRef<number | null>(null);
  // 🔒 React moves the DOM node when a keyed child changes place, and a moved node loses focus — so
  // the page that was just nudged takes it back, or the second arrow key would land on nothing.
  const nudged = useRef<number | null>(null);
  const [moves, setMoves] = useState(0);

  useEffect(() => {
    const page = nudged.current;
    if (page === null) return;
    nudged.current = null;
    tiles.current.get(page)?.focus();
  }, [moves]);

  const registerTile = useCallback(
    (page: number) =>
      (element: HTMLButtonElement | null): void => {
        if (element === null) tiles.current.delete(page);
        else tiles.current.set(page, element);
      },
    [],
  );

  // Which position of the strip a point is over. Hit-tested against the tiles themselves rather than
  // computed from a width: the strip wraps, and a wrapped row is not arithmetic.
  const positionUnder = useCallback(
    (x: number, y: number): number | null => {
      for (let position = 0; position < order.length; position += 1) {
        const page = order[position];
        if (page === undefined) continue;
        const tile = tiles.current.get(page);
        if (tile === undefined) continue;
        const rect = tile.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return position;
      }
      return null;
    },
    [order],
  );

  const startDrag =
    (page: number) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      dragging.current = page;
      const tile = event.currentTarget;
      // Capture keeps the page following a pointer that has left the tile — a finger included, which
      // is the whole reason this is a pointer gesture and not a mouse one (docs/11 §11.5a). Not every
      // environment the tests run in implements it.
      if (typeof tile.setPointerCapture === 'function') tile.setPointerCapture(event.pointerId);
    };

  const drag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const page = dragging.current;
    if (page === null) return;
    const target = positionUnder(event.clientX, event.clientY);
    if (target === null) return;
    setOrder((current) => {
      const from = current.indexOf(page);
      return from < 0 || from === target ? current : movePage(current, from, target);
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragging.current === null) return;
    dragging.current = null;
    const tile = event.currentTarget;
    if (
      typeof tile.hasPointerCapture === 'function' &&
      typeof tile.releasePointerCapture === 'function' &&
      tile.hasPointerCapture(event.pointerId)
    ) {
      tile.releasePointerCapture(event.pointerId);
    }
  };

  const nudge =
    (page: number) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const step = ARROW_STEPS[event.key];
      if (step === undefined) return;
      // An arrow key inside a list otherwise scrolls the page out from under the strip.
      event.preventDefault();
      setOrder((current) => {
        const from = current.indexOf(page);
        return from < 0 ? current : movePage(current, from, from + step);
      });
      nudged.current = page;
      setMoves((count) => count + 1);
    };

  // What each of the strip's four buttons sends, and what it says afterwards. Save sends the whole
  // of both — the permutation and one turn per page, the way a file reorder sends the whole order
  // (docs/07 §7.3) — while the two restores send a single `null` each, which is all it takes to put
  // a file back the way it arrived when nothing was ever done to it (docs/03 §3.3.16).
  const save = useMutation({
    mutationFn: (edit: { body: UpdateDocumentFileRequest; note: string }) =>
      pageApi.save(documentId, file.id, edit.body),
    onSuccess: (_document, edit) => {
      // The document is rebuilding, and it can appear in any list — hence the shared prefix.
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      if (edit.body.pageOrder === null) setOrder(naturalOrder(pageCount));
      if (edit.body.pageRotations === null) setTurns(noTurns(pageCount));
      void message.success(edit.note);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const saveBoth = (): void => {
    save.mutate({
      body: {
        pageOrder: order,
        // A file with nothing turned is a file with no turns at all, not a list of zeroes: the two
        // read the same and only one of them is what arrived.
        pageRotations: turns.every((turn) => turn === 0) ? null : toPageRotations(turns),
      },
      note: t('viewer.files.pages.saved'),
    });
  };

  // 🔒 Nothing at all for a file with no pages to arrange, whoever asks for it (docs/11 §11.5a).
  // The row does not offer the control on such a file either, and this is the same rule stated where
  // it cannot be got round.
  if (!hasArrangeablePages(file)) return null;

  const pending = !sameOrder(order, stored) || !sameTurns(turns, storedTurns);
  const busy = save.isPending;

  return (
    <div
      data-testid="page-strip"
      style={{
        marginTop: 8,
        padding: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        background: 'var(--legere-well)',
      }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {order.map((page, position) => {
            const turn = turns[page] ?? 0;
            const quarterTurned = turn === 1 || turn === 3;
            return (
              // The drag target and the two turns are siblings rather than nested: a button inside a
              // button is not a thing a browser will hit-test the way anybody means it.
              <div key={page} style={{ width: TILE_WIDTH }}>
                <button
                  ref={registerTile(page)}
                  type="button"
                  aria-label={t('viewer.files.pages.page', {
                    page: page + 1,
                    position: position + 1,
                    total: order.length,
                  })}
                  onPointerDown={startDrag(page)}
                  onPointerMove={drag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={nudge(page)}
                  style={{
                    width: '100%',
                    padding: 2,
                    border: `1px solid ${token.colorBorder}`,
                    borderRadius: token.borderRadiusSM,
                    background: token.colorBgContainer,
                    cursor: 'grab',
                    touchAction: 'none',
                  }}
                >
                  <div
                    style={{
                      height: TILE_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {/* An API route that 302s to a signed URL of one page of the original
                        (docs/07 §7.3, docs/10 §10.8). Asked for only because this strip is open.
                        🔒 It stays the page as it arrived whatever the turn says — the picture is
                        cached under bytes that cannot change — so the strip turns what it draws
                        rather than asking for it again (docs/11 §11.5a). */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      data-testid={`page-thumb-${page}`}
                      src={pageApi.thumbUrl(documentId, file.id, page)}
                      alt=""
                      loading="lazy"
                      style={{
                        // Quarter-turned, the picture's long side has to fit across the tile, so the
                        // two bounds swap with it.
                        maxWidth: quarterTurned ? TILE_HEIGHT : '100%',
                        maxHeight: quarterTurned ? TILE_WIDTH : '100%',
                        objectFit: 'contain',
                        transform: turn === 0 ? undefined : `rotate(${turn * 90}deg)`,
                      }}
                    />
                  </div>
                  {/* The page's own number, not its place in the strip: a file that reads 3, 1, 2
                      says so without anything having to be counted (docs/11 §11.5a). */}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {page + 1}
                  </Typography.Text>
                </button>

                {/* One page at a time, because a forty-page scan has three lying sideways and not
                    forty (docs/11 §11.5a). */}
                <div style={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
                  <Button
                    size="small"
                    type="text"
                    disabled={busy}
                    aria-label={t('viewer.files.pages.rotateLeft', { page: page + 1 })}
                    icon={<RotateLeftOutlined />}
                    onClick={() => setTurns((current) => turnPage(current, page, -1))}
                  />
                  <Button
                    size="small"
                    type="text"
                    disabled={busy}
                    aria-label={t('viewer.files.pages.rotateRight', { page: page + 1 })}
                    icon={<RotateRightOutlined />}
                    onClick={() => setTurns((current) => turnPage(current, page, 1))}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('viewer.files.pages.hint')}
        </Typography.Text>

        <Space wrap size={8}>
          <Button size="small" type="primary" disabled={!pending} loading={busy} onClick={saveBoth}>
            {t('viewer.files.pages.save')}
          </Button>
          {/* Discards what has been arranged and turned and sends nothing: the strip goes back to
              what the file says (docs/11 §11.5a). */}
          <Button
            size="small"
            disabled={!pending || busy}
            onClick={() => {
              setOrder(stored);
              setTurns(storedTurns);
            }}
          >
            {t('viewer.files.pages.cancel')}
          </Button>
          {/* The siblings of Clear crop: `null` puts the pages back in the order and the way up they
              arrived, and there was never anything to undo — both were instructions beside the bytes
              (docs/03 §3.3.16, docs/11 §11.5c). */}
          <Button
            size="small"
            type="link"
            disabled={file.pageOrder === null || busy}
            onClick={() =>
              save.mutate({
                body: { pageOrder: null },
                note: t('viewer.files.pages.restored'),
              })
            }
          >
            {t('viewer.files.pages.restore')}
          </Button>
          <Button
            size="small"
            type="link"
            disabled={file.pageRotations === null || busy}
            onClick={() =>
              save.mutate({
                body: { pageRotations: null },
                note: t('viewer.files.pages.turnsRestored'),
              })
            }
          >
            {t('viewer.files.pages.resetTurns')}
          </Button>
        </Space>
      </Space>
    </div>
  );
}

// The strip counts turns as plain numbers, because that is what turning one of them is arithmetic
// over; the contract counts them as the four values there are. This is where the two meet, without
// a type assertion (docs/14 §14.2).
function toPageRotations(turns: readonly number[]): PageRotations {
  return turns.map((turn) => {
    if (turn === 1) return 1;
    if (turn === 2) return 2;
    if (turn === 3) return 3;
    return 0;
  });
}
