'use client';

import { CloseOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Flex, Progress, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { useErrorMessage } from '../../shared/lib';

type ReceiptUploadStatus = 'waiting' | 'uploading' | 'uploaded' | 'duplicate' | 'failed';

type ReceiptUploadEntry = {
  key: string;
  file: File;
  fileName: string;
  size: number;
  status: ReceiptUploadStatus;
  loadedBytes: number;
  error?: string;
};

type ReceiptUploadSettlement =
  { status: 'uploaded' | 'duplicate' } | { status: 'failed'; error: string };

export function useReceiptUploads(refreshNewReceipts: boolean): {
  items: readonly ReceiptUploadEntry[];
  busy: boolean;
  send: (files: File[]) => void;
  clear: () => void;
} {
  const t = useTranslations('receipts');
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const entriesRef = useRef<ReceiptUploadEntry[]>([]);
  const [items, setItems] = useState<readonly ReceiptUploadEntry[]>([]);
  const runningRef = useRef(false);
  const nextKeyRef = useRef(0);

  const update = useCallback((change: (current: ReceiptUploadEntry[]) => ReceiptUploadEntry[]) => {
    entriesRef.current = change(entriesRef.current);
    setItems(entriesRef.current);
  }, []);

  const patch = useCallback(
    (key: string, change: (entry: ReceiptUploadEntry) => ReceiptUploadEntry) => {
      update((current) => current.map((entry) => (entry.key === key ? change(entry) : entry)));
    },
    [update],
  );

  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = entriesRef.current.find((entry) => entry.status === 'waiting');
        if (next === undefined) return;
        patch(next.key, (entry) => ({ ...entry, status: 'uploading', loadedBytes: 0 }));

        let shown = -1;
        const onProgress = (loadedBytes: number, totalBytes: number) => {
          const percent = totalBytes === 0 ? 0 : Math.floor((loadedBytes * 100) / totalBytes);
          if (percent === shown) return;
          shown = percent;
          // XHR counts the multipart envelope too; project its ratio onto the file's own size so
          // aggregate progress cannot pass 100% because of a boundary and headers.
          const fileBytes = Math.min(next.size, Math.floor((next.size * percent) / 100));
          patch(next.key, (entry) => ({ ...entry, loadedBytes: fileBytes }));
        };

        let settlement: ReceiptUploadSettlement;
        try {
          const result = await receiptApi.upload(next.file, onProgress);
          settlement = { status: result.created ? 'uploaded' : 'duplicate' };
        } catch (error: unknown) {
          const detail = describeError(error);
          settlement = { status: 'failed', error: detail };
          // Errors still ask for immediate attention, while the permanent panel keeps their full
          // accounting after the toast has gone. Successes need no toast: the batch is their receipt.
          void message.error(
            t('uploadBatch.errorToast', { fileName: next.fileName, error: detail }),
          );
        }

        patch(next.key, (entry) => ({ ...entry, ...settlement }));
        // A fresh row belongs at the top only in the upload-date order. Other orders keep their
        // current page still; opening that order afresh asks the server for the receipt in its real
        // sorted position after extraction rather than visually injecting it as "new".
        if (settlement.status === 'uploaded' && refreshNewReceipts) {
          void queryClient.invalidateQueries({ queryKey: receiptKeys.lists });
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [describeError, message, patch, queryClient, refreshNewReceipts, t]);

  const send = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      update((current) => {
        // A completed batch stays until dismissed, but choosing another set starts a new account.
        // Files dropped while one is active join that active batch instead.
        const base = current.some((entry) => !isReceiptUploadSettled(entry)) ? current : [];
        return [
          ...base,
          ...files.map((file): ReceiptUploadEntry => {
            nextKeyRef.current += 1;
            return {
              key: `receipt-upload-${nextKeyRef.current}`,
              file,
              fileName: file.name,
              size: file.size,
              status: 'waiting',
              loadedBytes: 0,
            };
          }),
        ];
      });
      void pump();
    },
    [pump, update],
  );

  const clear = useCallback(() => {
    if (entriesRef.current.some((entry) => !isReceiptUploadSettled(entry))) return;
    update(() => []);
  }, [update]);

  return {
    items,
    busy: items.some((entry) => !isReceiptUploadSettled(entry)),
    send,
    clear,
  };
}

export function ReceiptUploadPanel({
  items,
  busy,
  onClose,
}: {
  items: readonly ReceiptUploadEntry[];
  busy: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('receipts');
  if (items.length === 0) return null;

  const settled = items.filter(isReceiptUploadSettled).length;
  const uploaded = items.filter((entry) => entry.status === 'uploaded').length;
  const duplicates = items.filter((entry) => entry.status === 'duplicate').length;
  const failures = items.filter(
    (entry): entry is ReceiptUploadEntry & { status: 'failed'; error: string } =>
      entry.status === 'failed' && entry.error !== undefined,
  );
  const activeIndex = items.findIndex((entry) => entry.status === 'uploading');
  const current = activeIndex < 0 ? Math.min(settled + 1, items.length) : activeIndex + 1;
  const totalBytes = items.reduce((sum, entry) => sum + entry.size, 0);
  const sentBytes = items.reduce(
    (sum, entry) => sum + (isReceiptUploadSettled(entry) ? entry.size : entry.loadedBytes),
    0,
  );
  const percent =
    totalBytes === 0
      ? Math.round((settled * 100) / items.length)
      : Math.round((sentBytes * 100) / totalBytes);

  return (
    <Card
      size="small"
      role="region"
      aria-label={t('uploadBatch.label')}
      title={
        <Typography.Text strong aria-live="polite">
          {busy
            ? t('uploadBatch.progress', { current, total: items.length })
            : t('uploadBatch.finished', { uploaded, total: items.length })}
        </Typography.Text>
      }
      extra={
        busy ? null : (
          <Button
            type="text"
            size="small"
            aria-label={t('uploadBatch.close')}
            icon={<CloseOutlined aria-hidden />}
            onClick={onClose}
          />
        )
      }
    >
      <Progress
        percent={percent}
        showInfo={false}
        size="small"
        status={failures.length > 0 ? 'exception' : busy ? 'active' : 'success'}
        style={{ marginBottom: 0 }}
      />
      {!busy && (duplicates > 0 || failures.length > 0) && (
        <Typography.Text type="secondary">
          {t('uploadBatch.summary', { duplicates, failed: failures.length })}
        </Typography.Text>
      )}
      {failures.length > 0 && (
        <div role="alert" style={{ marginTop: 8 }}>
          <Typography.Text strong type="danger">
            {t('uploadBatch.errors')}
          </Typography.Text>
          <Flex vertical gap={4} style={{ marginTop: 4 }}>
            {failures.map((entry) => (
              <Typography.Text key={entry.key} type="danger">
                {entry.fileName}: {entry.error}
              </Typography.Text>
            ))}
          </Flex>
        </div>
      )}
    </Card>
  );
}

function isReceiptUploadSettled(entry: ReceiptUploadEntry): boolean {
  return entry.status === 'uploaded' || entry.status === 'duplicate' || entry.status === 'failed';
}
