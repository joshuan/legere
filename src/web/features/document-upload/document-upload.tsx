'use client';

import { InboxOutlined, LoadingOutlined, UploadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Space, Tag, Tooltip, Typography, Upload, theme } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { documentApi, documentKeys } from '../../entities/document';
import { useErrorMessage } from '../../shared/lib';

// One file on its way to the server (docs/11 §11.3). It exists on the screen before a byte is sent,
// because forty files chosen at once should be forty cards immediately — a progress modal over an
// empty grid says nothing about what is actually happening.
export type QueuedUpload = {
  key: string;
  file: File;
  status: 'waiting' | 'uploading' | 'failed';
  error?: string;
};

// Uploading from the browser (docs/11 §11.3). A queue, not a fan-out: files go **one at a time**, in
// the order they were chosen. Forty parallel uploads would saturate the connection, arrive
// interleaved, and make the pipeline queue jump about; one at a time is slower to finish and far
// easier to watch. Choosing more files appends to the same queue rather than starting a second one.
//
// With a `documentId` the same queue points at that document instead of the instance: the files are
// appended to it, in the order chosen, and the document rebuilds behind them (docs/11 §11.5a).
export function useDocumentUpload(documentId?: string) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  // The ref is the queue; the state is what the screen renders from it. One source of truth, so the
  // runner never reads a stale closure while React catches up.
  const queue = useRef<QueuedUpload[]>([]);
  const [items, setItems] = useState<QueuedUpload[]>([]);
  const running = useRef(false);
  const nextKey = useRef(0);

  const update = useCallback((change: (current: QueuedUpload[]) => QueuedUpload[]) => {
    queue.current = change(queue.current);
    setItems(queue.current);
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = queue.current.find((item) => item.status === 'waiting');
        if (next === undefined) return;
        update((current) =>
          current.map((item) => (item.key === next.key ? { ...item, status: 'uploading' } : item)),
        );

        try {
          const outcome = await sendOne(next.file, documentId);
          // The list is refreshed before the placeholder goes, so the card is replaced rather than
          // blinking out and back in. Every filter combination shows a different slice and a new
          // document may belong to any of them, hence the shared prefix.
          await queryClient.invalidateQueries({ queryKey: ['documents'] });
          if (documentId !== undefined) {
            await queryClient.invalidateQueries({ queryKey: documentKeys.detail(documentId) });
          }
          update((current) => current.filter((item) => item.key !== next.key));
          void message.success(t(`documents.upload.${outcome}`, { name: next.file.name }), 3);
        } catch (error: unknown) {
          // The card stays, wearing its own error; the queue carries on. One rejected file must not
          // take the other thirty-nine with it.
          update((current) =>
            current.map((item) =>
              item.key === next.key
                ? { ...item, status: 'failed', error: describeError(error) }
                : item,
            ),
          );
        }
      }
    } finally {
      running.current = false;
    }
  }, [describeError, documentId, message, queryClient, t, update]);

  const send = useCallback(
    (file: File) => {
      nextKey.current += 1;
      update((current) => [
        ...current,
        { key: `upload-${nextKey.current}`, file, status: 'waiting' },
      ]);
      void pump();
    },
    [pump, update],
  );

  const dismiss = useCallback(
    (key: string) => update((current) => current.filter((item) => item.key !== key)),
    [update],
  );

  return { send, dismiss, items, busy: items.some((item) => item.status !== 'failed') };
}

// Which of the three things happened, named as the message key that says so. Deduplication doing its
// job is one of them, not an error (ADR-009).
async function sendOne(
  file: File,
  documentId: string | undefined,
): Promise<'done' | 'duplicate' | 'added'> {
  if (documentId !== undefined) {
    await documentApi.addFile(documentId, file);
    return 'added';
  }
  const result = await documentApi.upload(file);
  return result.created ? 'done' : 'duplicate';
}

// A file that is not a document yet: the same shape as the card it is about to become, so the grid
// does not reflow when it does (docs/11 §11.3).
export function UploadingCard({
  upload,
  onDismiss,
}: {
  upload: QueuedUpload;
  onDismiss: () => void;
}) {
  const t = useTranslations();
  const { token } = theme.useToken();
  const failed = upload.status === 'failed';

  return (
    <Card
      styles={{ body: { padding: 12 } }}
      cover={
        <div
          style={{
            height: 168,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--legere-well)',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {failed ? (
            <InboxOutlined style={{ fontSize: 38, color: token.colorError }} aria-hidden />
          ) : (
            <LoadingOutlined
              style={{ fontSize: 32, color: token.colorTextQuaternary }}
              aria-hidden
            />
          )}
        </div>
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Tooltip title={upload.file.name}>
          <Typography.Text ellipsis style={{ display: 'block' }}>
            {upload.file.name}
          </Typography.Text>
        </Tooltip>
        {failed ? (
          <Space size={4} wrap>
            <Tag color="red">{t('documents.upload.failed')}</Tag>
            <Button size="small" type="link" onClick={onDismiss} style={{ padding: 0 }}>
              {t('documents.upload.dismiss')}
            </Button>
          </Space>
        ) : (
          <Tag color={upload.status === 'uploading' ? 'processing' : 'default'}>
            {upload.status === 'uploading'
              ? t('documents.upload.uploading')
              : t('documents.upload.waiting')}
          </Tag>
        )}
        {failed && upload.error !== undefined && (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {upload.error}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}

// The same file on its way into a document that already exists (docs/11 §11.5a): a row rather than a
// card, because the Files section is a list and a placeholder should look like what it will become.
export function UploadingRow({
  upload,
  onDismiss,
}: {
  upload: QueuedUpload;
  onDismiss: () => void;
}) {
  const t = useTranslations();
  const failed = upload.status === 'failed';

  return (
    <Space size={8} wrap>
      {failed ? <InboxOutlined aria-hidden /> : <LoadingOutlined aria-hidden />}
      <Typography.Text>{upload.file.name}</Typography.Text>
      {failed ? (
        <>
          <Tag color="red">{t('documents.upload.failed')}</Tag>
          {upload.error !== undefined && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {upload.error}
            </Typography.Text>
          )}
          <Button size="small" type="link" onClick={onDismiss} style={{ padding: 0 }}>
            {t('documents.upload.dismiss')}
          </Button>
        </>
      ) : (
        <Tag color={upload.status === 'uploading' ? 'processing' : 'default'}>
          {upload.status === 'uploading'
            ? t('documents.upload.uploading')
            : t('documents.upload.waiting')}
        </Tag>
      )}
    </Space>
  );
}

export function UploadButton({
  onFiles,
  label,
}: {
  onFiles: (file: File) => void;
  label?: string;
}) {
  const t = useTranslations();

  return (
    <Upload
      multiple
      showUploadList={false}
      // The request is ours: antd would otherwise post multipart to an endpoint that takes the file
      // as the body itself.
      beforeUpload={(file: RcFile) => {
        onFiles(file);
        return Upload.LIST_IGNORE;
      }}
    >
      <Button icon={<UploadOutlined />}>{label ?? t('documents.upload.action')}</Button>
    </Upload>
  );
}

// What a drag is carrying, decided at `dragover` time. The file list itself is unreadable until the
// drop — the browser hides the payload of a drag in progress — so `types` is the only evidence
// available, and anything dragged in from outside the page is announced there as `Files`. Dragged
// text, a link or a selection says so here and is left entirely alone: an overlay promising an
// upload that cannot happen is worse than no overlay, and taking the default away from such a drag
// would break dropping text into an input.
function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && Array.from(transfer.types).includes('Files');
}

// The whole screen is the drop zone (docs/11 §11.3). The listeners are on the window rather than on
// a box around the grid, so a file dropped on the heading, on the filter bar or on the empty space
// beside the cards lands exactly like one dropped on a card — and the browser's own default for a
// file dropped on a page, which is to navigate away to it, is taken away wherever it would fire.
export function UploadDropZone({
  onFiles,
  children,
}: {
  onFiles: (file: File) => void;
  children: ReactNode;
}) {
  const t = useTranslations();
  const { token } = theme.useToken();
  const [dragging, setDragging] = useState(false);

  // Enter and leave are counted in pairs rather than believed one at a time. `dragleave` fires on an
  // element the moment the pointer crosses into one of its own children, so a handler that lowers
  // the overlay on the first leave lowers it in the middle of a drag and raises it again in the next
  // frame — the flicker. Every `dragenter` has exactly one `dragleave`, so while the count is above
  // zero the drag is still somewhere over the page, whatever the tree under the pointer looks like.
  // The other cure — ignoring a leave whose `relatedTarget` is inside the zone — has to reason about
  // a target that is `null` both when the pointer leaves the window (clear) and when it crosses into
  // some browsers' shadow content (do not clear); the counter needs no such special case.
  const depth = useRef(0);

  useEffect(() => {
    const clear = () => {
      depth.current = 0;
      setDragging(false);
    };

    const enter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current += 1;
      setDragging(true);
    };

    const over = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      // Without this the drop never happens: the browser reads an un-prevented `dragover` as "this
      // is not a drop target" and falls back to opening the file in the tab.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const leave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      // Never below zero: a drag that began before this screen mounted would otherwise leave a debt
      // that the next one has to pay off before anything appears.
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };

    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      clear();
      for (const file of files) onFiles(file);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    // A drag abandoned with Escape ends without a leave in some browsers; this is the one event that
    // is always there to say it is over.
    window.addEventListener('dragend', clear);

    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', clear);
    };
  }, [onFiles]);

  return (
    <>
      {children}
      {dragging && (
        // Over everything and taking nothing: the drag has to keep reaching the page underneath, and
        // a surface that swallowed the pointer would end the drag it is announcing.
        <div
          style={{
            position: 'fixed',
            inset: 8,
            zIndex: 1000,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: token.borderRadiusLG,
            border: `2px dashed ${token.colorPrimary}`,
            background: token.colorBgMask,
          }}
        >
          <div
            style={{
              padding: '24px 32px',
              borderRadius: token.borderRadiusLG,
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              textAlign: 'center',
            }}
          >
            <InboxOutlined
              style={{ fontSize: 40, color: token.colorPrimary, display: 'block' }}
              aria-hidden
            />
            <Typography.Text style={{ display: 'block', marginTop: 8 }}>
              {t('documents.upload.hint')}
            </Typography.Text>
          </div>
        </div>
      )}
    </>
  );
}
