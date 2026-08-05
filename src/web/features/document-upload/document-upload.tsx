'use client';

import { InboxOutlined, LoadingOutlined, UploadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Space, Tag, Tooltip, Typography, Upload, theme } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { documentApi } from '../../entities/document';
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
export function useDocumentUpload() {
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
          const result = await documentApi.upload(next.file);
          // The list is refreshed before the placeholder goes, so the card is replaced rather than
          // blinking out and back in. Every filter combination shows a different slice and a new
          // document may belong to any of them, hence the shared prefix.
          await queryClient.invalidateQueries({ queryKey: ['documents'] });
          update((current) => current.filter((item) => item.key !== next.key));
          void message.success(
            result.created
              ? t('documents.upload.done', { name: next.file.name })
              : // Deduplication doing its job is not an error (ADR-009).
                t('documents.upload.duplicate', { name: next.file.name }),
            3,
          );
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
  }, [describeError, message, queryClient, t, update]);

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

export function UploadButton({ onFiles }: { onFiles: (file: File) => void }) {
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
      <Button icon={<UploadOutlined />}>{t('documents.upload.action')}</Button>
    </Upload>
  );
}

// Wraps the grid so a file can be dropped anywhere on it, without the drop zone drawing a box around
// everything when nothing is being dragged.
export function UploadDropZone({
  onFiles,
  children,
}: {
  onFiles: (file: File) => void;
  children: ReactNode;
}) {
  const t = useTranslations();

  return (
    <Upload.Dragger
      multiple
      openFileDialogOnClick={false}
      showUploadList={false}
      beforeUpload={(file: RcFile) => {
        onFiles(file);
        return Upload.LIST_IGNORE;
      }}
      style={{ background: 'transparent', border: 'none', padding: 0 }}
    >
      <div style={{ textAlign: 'start', cursor: 'default' }}>{children}</div>
      <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}>
        <InboxOutlined />
      </p>
      <p className="ant-upload-hint">{t('documents.upload.hint')}</p>
    </Upload.Dragger>
  );
}
