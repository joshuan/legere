'use client';

import {
  DeleteOutlined,
  ExpandOutlined,
  ExportOutlined,
  FileUnknownOutlined,
  PlusOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  ScissorOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Checkbox, Popconfirm, Space, Tooltip, Typography, Upload, theme } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  NO_ROTATION,
  type DocumentDetailDto,
  type DocumentFileDto,
  type DocumentPageDto,
  type Rotation,
  type Turn,
} from '../../../shared/contracts/documents';
import { documentApi, documentFiles, documentKeys } from '../../entities/document';
import { CropEditor } from '../crop-editor';
import { useErrorMessage } from '../../shared/lib';
import { MovePagesDialog } from './move-pages-dialog';
import {
  canCrop,
  canTurn,
  hasPicture,
  movePage,
  sameOrder,
  standsForWholeFile,
  storedOrder,
  turnOf,
  turnedPage,
  turnsToSave,
} from './page-order';

// The page strip of docs/11 §11.5a: **every page of every file**, in the order the canonical will
// hold them (docs/03 §3.3.17, ADR-025). This is what replaced the per-file "Arrange pages" of M53 —
// two strips that disagreed about one document is exactly what ADR-025 was written to end.
//
// The order and the turns live here until they are saved: nothing is sent while a page is being
// moved, and Cancel means nothing was sent at all. What goes out is the **whole order**, every page
// of the document exactly once (docs/07 §7.3), because a whole permutation is the only shape a
// reorder cannot be half applied in.

// One position at a time, in whichever direction the strip is being read: it wraps rows, so up is
// left and down is right. 🔒 The arrow keys are not a convenience — a hit area only a mouse can use
// is half a fix (docs/11 §11.3, §11.5a).
const ARROW_STEPS: Record<string, number | undefined> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

const TILE_WIDTH = 116;
const THUMB_HEIGHT = 132;
// The insert point between two tiles: narrow, because it is a seam and not a column, and tall
// enough that a file can be dropped on it without aiming.
const SEAM_WIDTH = 24;

export type PageStripProps = {
  document: DocumentDetailDto;
  // What a file dropped — or chosen — at a seam does: the panel of docs/11 §11.3a takes it from
  // here, addressed to this document **at that position**.
  onInsertFiles: (files: File[], at: number) => void;
  // 🔒 A peek at somebody else's document shows what it is made of and takes the work away
  // (docs/11 §11.5e).
  readOnly?: boolean;
};

export function PageStrip({ document, onInsertFiles, readOnly = false }: PageStripProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const stored = useMemo(() => storedOrder(document.pages), [document.pages]);
  const pagesById = useMemo(
    () => new Map(document.pages.map((page) => [page.id, page])),
    [document.pages],
  );
  const filesById = useMemo(
    () => new Map(document.files.map((file) => [file.id, file])),
    [document.files],
  );

  const [order, setOrder] = useState<string[]>(stored);
  const [turns, setTurns] = useState<ReadonlyMap<string, Rotation | null>>(() => new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [cropping, setCropping] = useState<string | null>(null);
  const [moving, setMoving] = useState<readonly string[] | null>(null);

  // 🔒 Keyed by the list itself, exactly as the crop editor is keyed by its file: a background
  // refetch while the pipeline works must not wipe out an order somebody is in the middle of
  // arranging. The key changes when the *set* of pages does — a page removed, a file added — which
  // is precisely when a pending order stops meaning anything.
  const key = stored.join('/');
  const [arranging, setArranging] = useState<string | null>(null);
  if (arranging !== key) {
    setArranging(key);
    setOrder(stored);
    setTurns(new Map());
    setSelected(new Set());
  }

  // The tiles, by the page they show, so a drag can ask which one a pointer is over and a keyboard
  // move can give the page its focus back afterwards.
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const dragging = useRef<string | null>(null);
  // 🔒 React moves the DOM node when a keyed child changes place, and a moved node loses focus — so
  // the page that was just nudged takes it back, or the second arrow key would land on nothing.
  const nudged = useRef<string | null>(null);
  const [moves, setMoves] = useState(0);
  const [seam, setSeam] = useState<number | null>(null);

  useEffect(() => {
    const pageId = nudged.current;
    if (pageId === null) return;
    nudged.current = null;
    tiles.current.get(pageId)?.focus();
  }, [moves]);

  const registerTile = useCallback(
    (pageId: string) =>
      (element: HTMLButtonElement | null): void => {
        if (element === null) tiles.current.delete(pageId);
        else tiles.current.set(pageId, element);
      },
    [],
  );

  // Which position of the strip a point is over. Hit-tested against the tiles themselves rather than
  // computed from a width: the strip wraps, and a wrapped row is not arithmetic.
  const positionUnder = useCallback(
    (x: number, y: number): number | null => {
      for (let position = 0; position < order.length; position += 1) {
        const pageId = order[position];
        if (pageId === undefined) continue;
        const tile = tiles.current.get(pageId);
        if (tile === undefined) continue;
        const rect = tile.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return position;
      }
      return null;
    },
    [order],
  );

  const refresh = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(document.id) });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  }, [document.id, queryClient]);

  // --- what Save sends -------------------------------------------------------------------------
  //
  // The turns first, one request per page whose turn changed, and the whole order after them. Each
  // answers with the document (docs/07 §7.3), and the order is what the reader is looking at, so it
  // goes last and has the last word.
  const pendingTurns = turnsToSave(document.pages, turns);
  const orderChanged = !sameOrder(order, stored);
  const pending = orderChanged || pendingTurns.length > 0;

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      for (const { pageId, turn } of pendingTurns) {
        await documentApi.updatePage(document.id, pageId, { turn });
      }
      if (orderChanged) await documentApi.reorderPages(document.id, { order });
    },
    onSuccess: () => {
      void message.success(t('viewer.pages.saved'), 2);
      refresh();
    },
    // 🔒 The work is not thrown away by a request that failed: the strip keeps what it was holding,
    // and the refetch under it re-reads whatever did land.
    onError: (error: unknown) => {
      void message.error(describeError(error));
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (pageId: string) => documentApi.removePage(document.id, pageId),
    onSuccess: () => {
      void message.success(t('viewer.pages.removeDone'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // Not a deletion, and it does not carry the reader off to the parts either: they are looking at
  // this document, and what was cut off is a document they can find from the links it now carries
  // (docs/05 §5.6).
  const split = useMutation({
    mutationFn: (at: number) => documentApi.splitAtPages(document.id, { at: [at] }),
    onSuccess: () => {
      void message.success(t('viewer.pages.splitDone'), 3);
      refresh();
      void queryClient.invalidateQueries({ queryKey: documentKeys.links(document.id) });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const busy = save.isPending || remove.isPending || split.isPending;
  // 🔒 A position is a place in the list the server was last shown (docs/03 §3.3.17), so everything
  // that names one goes quiet while the strip holds an order nobody has sent. Save or Cancel first —
  // which is "nothing is sent until it is saved" said from the other side.
  const sending = busy || pending;

  // --- moving a page ---------------------------------------------------------------------------

  const startDrag =
    (pageId: string) =>
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      if (readOnly) return;
      dragging.current = pageId;
      const tile = event.currentTarget;
      // Capture keeps the page following a pointer that has left the tile — a finger included, which
      // is the whole reason this is a pointer gesture and not a mouse one (docs/11 §11.5a). Not every
      // environment the tests run in implements it.
      if (typeof tile.setPointerCapture === 'function') tile.setPointerCapture(event.pointerId);
    };

  const drag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const pageId = dragging.current;
    if (pageId === null) return;
    const target = positionUnder(event.clientX, event.clientY);
    if (target === null) return;
    setOrder((current) => {
      const from = current.indexOf(pageId);
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
    (pageId: string) =>
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (readOnly) return;
      const step = ARROW_STEPS[event.key];
      if (step === undefined) return;
      // An arrow key inside a list otherwise scrolls the page out from under the strip.
      event.preventDefault();
      setOrder((current) => {
        const from = current.indexOf(pageId);
        return from < 0 ? current : movePage(current, from, from + step);
      });
      nudged.current = pageId;
      setMoves((count) => count + 1);
    };

  const turn = (pageId: string, gesture: Turn): void => {
    const page = pagesById.get(pageId);
    if (page === undefined) return;
    setTurns((current) => {
      const next = new Map(current);
      next.set(pageId, turnedPage(turnOf(page, current), gesture));
      return next;
    });
  };

  const toggleSelected = (pageId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(pageId)) next.add(pageId);
      return next;
    });
  };

  // --- a file dropped between two pages --------------------------------------------------------

  const dropAt =
    (at: number) =>
    (event: ReactDragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setSeam(null);
      if (readOnly || sending) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) onInsertFiles(files, at);
    };

  const dragOverSeam =
    (at: number) =>
    (event: ReactDragEvent<HTMLDivElement>): void => {
      // Without this the drop never happens: the browser reads an un-prevented `dragover` as "this
      // is not a drop target" and falls back to opening the file in the tab.
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!readOnly && !sending) setSeam(at);
    };

  const total = order.length;

  return (
    <div
      data-testid="page-strip"
      style={{
        padding: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        background: 'var(--legere-well)',
      }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={8} align="center">
          <Typography.Text strong>{t('viewer.pages.heading', { count: total })}</Typography.Text>
          {!readOnly && selected.size > 0 && (
            <>
              <Typography.Text type="secondary">
                {t('viewer.pages.selected', { count: selected.size })}
              </Typography.Text>
              {/* Named in words rather than drawn as an icon beside them: an icon with a label is
                  a second name for one control, and a screen reader would read both. */}
              <Button size="small" disabled={sending} onClick={() => setMoving([...selected])}>
                {t('viewer.pages.moveSelection')}
              </Button>
              <Button size="small" type="link" onClick={() => setSelected(new Set())}>
                {t('viewer.pages.clearSelection')}
              </Button>
            </>
          )}
        </Space>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 0 }}>
          {/* The seam before the first page: a document's front is a place a page can go too. */}
          <Seam
            at={0}
            active={seam === 0}
            hidden={readOnly}
            disabled={sending}
            onFiles={(files) => onInsertFiles(files, 0)}
            onDragOver={dragOverSeam(0)}
            onDragLeave={() => setSeam(null)}
            onDrop={dropAt(0)}
          />
          {order.map((pageId, position) => {
            const page = pagesById.get(pageId);
            if (page === undefined) return null;
            const file = filesById.get(page.fileId);
            const shownTurn = turnOf(page, turns);
            return (
              <div key={pageId} style={{ display: 'flex', alignItems: 'stretch' }}>
                <Tile
                  page={page}
                  file={file}
                  documentId={document.id}
                  position={position}
                  total={total}
                  turn={shownTurn}
                  selected={selected.has(pageId)}
                  readOnly={readOnly}
                  sending={sending}
                  onlyPage={total <= 1}
                  registerTile={registerTile(pageId)}
                  onPointerDown={startDrag(pageId)}
                  onPointerMove={drag}
                  onPointerUp={endDrag}
                  onKeyDown={nudge(pageId)}
                  onSelect={() => toggleSelected(pageId)}
                  onTurn={(gesture) => turn(pageId, gesture)}
                  onCrop={() => setCropping(pageId)}
                  onSplit={() => split.mutate(position)}
                  onRemove={() => remove.mutate(pageId)}
                  onMove={() => setMoving([pageId])}
                />
                <Seam
                  at={position + 1}
                  active={seam === position + 1}
                  hidden={readOnly}
                  disabled={sending}
                  onFiles={(files) => onInsertFiles(files, position + 1)}
                  onDragOver={dragOverSeam(position + 1)}
                  onDragLeave={() => setSeam(null)}
                  onDrop={dropAt(position + 1)}
                />
              </div>
            );
          })}
        </div>

        {!readOnly && (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('viewer.pages.hint')}
            </Typography.Text>
            {pending && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                {t('viewer.pages.pendingNote')}
              </Typography.Text>
            )}
            <Space wrap size={8}>
              <Button
                size="small"
                type="primary"
                disabled={!pending}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                {t('viewer.pages.save')}
              </Button>
              {/* Discards what has been arranged and turned and sends nothing: the strip goes back
                  to what the document says (docs/11 §11.5a). */}
              <Button
                size="small"
                disabled={!pending || busy}
                onClick={() => {
                  setOrder(stored);
                  setTurns(new Map());
                }}
              >
                {t('viewer.pages.cancel')}
              </Button>
            </Space>
          </>
        )}
      </Space>

      {cropping !== null &&
        (() => {
          const page = pagesById.get(cropping);
          const file = page === undefined ? undefined : filesById.get(page.fileId);
          if (page === undefined || file === undefined) return null;
          return (
            <CropEditor
              open
              documentId={document.id}
              page={page}
              file={file}
              onClose={() => {
                setCropping(null);
                refresh();
              }}
            />
          );
        })()}

      {moving !== null && (
        <MovePagesDialog
          open
          documentId={document.id}
          pageIds={moving}
          onClose={() => setMoving(null)}
          onMoved={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

// One page of the document: the picture, where it stands, where it came from, and everything that
// can be done to it in place (docs/11 §11.5a).
function Tile({
  page,
  file,
  documentId,
  position,
  total,
  turn,
  selected,
  readOnly,
  sending,
  onlyPage,
  registerTile,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onSelect,
  onTurn,
  onCrop,
  onSplit,
  onRemove,
  onMove,
}: {
  page: DocumentPageDto;
  file: DocumentFileDto | undefined;
  documentId: string;
  position: number;
  total: number;
  turn: Rotation | null;
  selected: boolean;
  readOnly: boolean;
  sending: boolean;
  onlyPage: boolean;
  registerTile: (element: HTMLButtonElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSelect: () => void;
  onTurn: (gesture: Turn) => void;
  onCrop: () => void;
  onSplit: () => void;
  onRemove: () => void;
  onMove: () => void;
}) {
  const t = useTranslations();
  const { token } = theme.useToken();

  const name = file?.name ?? '';
  const image = file?.isImage ?? false;
  // 🔒 "The whole file" is the entry a file takes while nobody has counted its pages — and a
  // photograph is never one of them. An image is one page and always was, whatever a page count
  // says, so it is named as itself (docs/03 §3.3.17).
  const whole = standsForWholeFile(page) && !image;
  // Where this page came from, in the words the strip labels it with: "lease.pdf, page 3" is what
  // makes a strip across two scans readable, since "page 3" means nothing in a document holding
  // three files with a page 3 each (docs/11 §11.5a).
  const source = whole
    ? t('viewer.pages.sourceWhole', { file: name })
    : image
      ? t('viewer.pages.sourceFile', { file: name })
      : t('viewer.pages.sourcePage', { file: name, page: (page.pageIndex ?? 0) + 1 });

  const picture = hasPicture(page, file);
  const pictureUrl =
    file === undefined
      ? null
      : file.isImage
        ? documentFiles.fileContent(documentId, file.id)
        : page.pageIndex === null
          ? null
          : documentFiles.pageThumb(documentId, file.id, page.pageIndex);

  const quarterTurned = turn !== null && (turn.quarterTurns === 1 || turn.quarterTurns === 3);
  const shown = turn ?? NO_ROTATION;
  const transform = [
    shown.quarterTurns === 0 ? '' : `rotate(${shown.quarterTurns * 90}deg)`,
    shown.mirrored ? 'scaleX(-1)' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  const action = (label: string, icon: ReactNode, onClick: () => void, disabled: boolean) => (
    <Tooltip title={label}>
      <Button
        size="small"
        type="text"
        aria-label={label}
        icon={icon}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  );

  return (
    <div style={{ width: TILE_WIDTH }}>
      {/* The drag target and everything else are siblings rather than nested: a button inside a
          button is not a thing a browser will hit-test the way anybody means it. */}
      <button
        ref={registerTile}
        type="button"
        aria-label={t('viewer.pages.tile', { position: position + 1, total, source })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        style={{
          width: '100%',
          padding: 2,
          border: `1px solid ${selected ? token.colorPrimary : token.colorBorder}`,
          borderRadius: token.borderRadiusSM,
          background: token.colorBgContainer,
          cursor: readOnly ? 'default' : 'grab',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            height: THUMB_HEIGHT,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {picture && pictureUrl !== null ? (
            // An API route that 302s to a signed URL of the page as it arrived, or streams the
            // volume's own bytes (docs/10 §10.8). 🔒 It stays the page as it arrived whatever the
            // turn says — the picture is cached under bytes that cannot change — so the strip turns
            // what it draws rather than asking for it again (docs/11 §11.5a).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              data-testid={`page-thumb-${page.id}`}
              src={pictureUrl}
              alt=""
              loading="lazy"
              style={{
                // Quarter-turned, the picture's long side has to fit across the tile, so the two
                // bounds swap with it.
                maxWidth: quarterTurned ? THUMB_HEIGHT : '100%',
                maxHeight: quarterTurned ? TILE_WIDTH : '100%',
                objectFit: 'contain',
                ...(transform === '' ? {} : { transform }),
              }}
            />
          ) : (
            // 🔒 A file nobody has counted the pages of: one entry standing for the whole of it, and
            // the strip says so rather than drawing a page it cannot name (docs/03 §3.3.17).
            <Space direction="vertical" size={0} align="center">
              <FileUnknownOutlined
                style={{ fontSize: 24, color: token.colorTextQuaternary }}
                aria-hidden
              />
              <Typography.Text type="secondary" style={{ fontSize: 11, textAlign: 'center' }}>
                {t('viewer.pages.whole')}
              </Typography.Text>
            </Space>
          )}
        </div>
        {/* Where it stands in the **document**, which is the number a person counts by here. */}
        <Typography.Text style={{ fontSize: 12 }}>{position + 1}</Typography.Text>
      </button>

      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2, tooltip: source }}
        style={{ fontSize: 11, marginBottom: 2, textAlign: 'center' }}
      >
        {source}
      </Typography.Paragraph>

      {!readOnly && (
        <Space direction="vertical" size={0} style={{ width: '100%' }} align="center">
          <Space size={0} wrap style={{ justifyContent: 'center' }}>
            <Checkbox
              checked={selected}
              aria-label={t('viewer.pages.select', { position: position + 1 })}
              onChange={onSelect}
            />
            {action(
              t('viewer.pages.turnLeft', { position: position + 1 }),
              <RotateLeftOutlined />,
              () => onTurn('LEFT'),
              !canTurn(page, file),
            )}
            {action(
              t('viewer.pages.turnRight', { position: position + 1 }),
              <RotateRightOutlined />,
              () => onTurn('RIGHT'),
              !canTurn(page, file),
            )}
          </Space>
          <Space size={0} wrap style={{ justifyContent: 'center' }}>
            {action(
              t('viewer.pages.crop', { position: position + 1 }),
              <ExpandOutlined />,
              onCrop,
              sending || !canCrop(page, file),
            )}
            {/* A cut before the first page is a cut with nothing on one side of it, so it is not
                offered at all rather than refused after the fact (docs/07 §7.3). */}
            {action(
              t('viewer.pages.splitHere', { position: position + 1 }),
              <ScissorOutlined />,
              onSplit,
              sending || position === 0,
            )}
            {action(
              t('viewer.pages.move', { position: position + 1 }),
              <ExportOutlined />,
              onMove,
              sending,
            )}
            {/* Destructive, so it confirms and names what it is about (docs/11 §11.14). Not offered
                on the only page there is: a document is emptied by deleting it. */}
            <Popconfirm
              title={t('viewer.pages.removeConfirm', { position: position + 1 })}
              okText={t('viewer.pages.removeOk')}
              cancelText={t('viewer.pages.moveCancel')}
              disabled={sending || onlyPage}
              onConfirm={onRemove}
            >
              <Tooltip title={t('viewer.pages.remove', { position: position + 1 })}>
                <Button
                  size="small"
                  type="text"
                  danger
                  aria-label={t('viewer.pages.remove', { position: position + 1 })}
                  icon={<DeleteOutlined />}
                  disabled={sending || onlyPage}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        </Space>
      )}
    </div>
  );
}

// The seam between two pages: where a file dropped from the desktop goes, and — pressed — where the
// file picker sends what is chosen (docs/11 §11.5a, §11.3a). 🔒 A real button, because the drop is a
// pointer gesture and a gesture only a pointer can make is half a fix (docs/11 §11.3).
function Seam({
  at,
  active,
  hidden,
  disabled,
  onFiles,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  at: number;
  active: boolean;
  hidden: boolean;
  disabled: boolean;
  onFiles: (files: File[]) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
}) {
  const t = useTranslations();
  const { token } = theme.useToken();

  if (hidden) return null;

  const label = t('viewer.pages.insert', { position: at + 1 });

  return (
    <div
      data-testid={`page-seam-${at}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        width: SEAM_WIDTH,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: token.borderRadiusSM,
        // Quiet until it matters: a seam that shouted would make the strip a column of plus signs.
        background: active ? token.colorPrimaryBg : 'transparent',
        outline: active ? `2px dashed ${token.colorPrimary}` : 'none',
      }}
    >
      <Upload
        multiple
        showUploadList={false}
        disabled={disabled}
        // The request is ours: antd would otherwise post multipart to an endpoint that takes the
        // file as the body itself. Handed over **once, whole**: antd asks about every chosen file
        // in turn, and sending them one at a time would give each the same position and so put them
        // in backwards (docs/11 §11.3a).
        beforeUpload={(file: RcFile, chosen: RcFile[]) => {
          if (file === chosen[0]) onFiles([...chosen]);
          return Upload.LIST_IGNORE;
        }}
      >
        <Tooltip title={label}>
          <Button
            size="small"
            type="text"
            aria-label={label}
            disabled={disabled}
            icon={<PlusOutlined style={{ fontSize: 10 }} />}
          />
        </Tooltip>
      </Upload>
    </div>
  );
}
