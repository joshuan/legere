'use client';

import { CloseOutlined, FileImageOutlined, PlusOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Empty,
  Flex,
  Image,
  Progress,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { UploadDropZone } from '../../features/document-upload';
import { useErrorMessage } from '../../shared/lib';

const LIVE_REFRESH_MS = 5000;

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

export function ReceiptsScreen() {
  const t = useTranslations('receipts');
  const format = useFormatter();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploads = useReceiptUploads();
  const receipts = useInfiniteQuery({
    queryKey: receiptKeys.list,
    queryFn: ({ pageParam }) => receiptApi.list(pageParam === '' ? undefined : pageParam),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      (query.state.data?.pages ?? []).some((page) => page.items.some((item) => item.processing))
        ? LIVE_REFRESH_MS
        : false,
  });
  const items = useMemo(
    () => (receipts.data?.pages ?? []).flatMap((page) => page.items),
    [receipts.data],
  );
  const columns: ColumnsType<ReceiptListItemDto> = [
    {
      key: 'thumb',
      width: 72,
      render: (_, receipt) => <ReceiptThumbnail receipt={receipt} />,
    },
    {
      title: t('fields.vendor'),
      key: 'vendor',
      render: (_, receipt) => (
        <Link href={`/receipts/${receipt.id}`}>
          <Typography.Text strong>{vendorOf(receipt) ?? t('unknownVendor')}</Typography.Text>
        </Link>
      ),
    },
    {
      title: t('fields.purchasedAt'),
      key: 'date',
      width: 150,
      render: (_, receipt) =>
        [stringValue(receipt, 'purchasedAt'), stringValue(receipt, 'purchasedTime')]
          .filter((value) => value !== null)
          .join(' · ') || '—',
    },
    {
      title: t('fields.total'),
      key: 'total',
      width: 130,
      render: (_, receipt) => moneyValue(receipt.extracted?.values.total) ?? '—',
    },
    {
      title: t('added'),
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' }),
    },
    {
      key: 'status',
      width: 140,
      render: (_, receipt) => <ReceiptStatus receipt={receipt} />,
    },
  ];

  return (
    <UploadDropZone onFiles={uploads.send} hint={t('dropHint')}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: 24 }}>
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <ReceiptUploadPanel items={uploads.items} busy={uploads.busy} onClose={uploads.clear} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {t('title')}
              </Typography.Title>
              <Typography.Text type="secondary">{t('uploadHint')}</Typography.Text>
            </div>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={uploads.busy}
              onClick={() => inputRef.current?.click()}
            >
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                uploads.send(files);
              }}
            />
          </div>

          {receipts.isLoading ? (
            <div style={{ textAlign: 'center', padding: 64 }}>
              <Spin />
            </div>
          ) : items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('empty')} />
          ) : (
            <>
              <div className="receipt-desktop-list">
                <Table rowKey="id" columns={columns} dataSource={items} pagination={false} />
              </div>
              <div className="receipt-mobile-list">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {items.map((receipt) => (
                    <Link key={receipt.id} href={`/receipts/${receipt.id}`}>
                      <Card size="small">
                        <div style={{ display: 'flex', gap: 14 }}>
                          <ReceiptThumbnail receipt={receipt} />
                          <Space direction="vertical" size={2} style={{ minWidth: 0 }}>
                            <Typography.Text strong ellipsis>
                              {vendorOf(receipt) ?? t('unknownVendor')}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {[
                                stringValue(receipt, 'purchasedAt'),
                                stringValue(receipt, 'purchasedTime'),
                                moneyValue(receipt.extracted?.values.total),
                              ]
                                .filter((value) => value !== null)
                                .join(' · ') || receipt.fileName}
                            </Typography.Text>
                            <ReceiptStatus receipt={receipt} />
                          </Space>
                        </div>
                      </Card>
                    </Link>
                  ))}
                </Space>
              </div>
            </>
          )}

          {receipts.hasNextPage && (
            <Button
              loading={receipts.isFetchingNextPage}
              onClick={() => void receipts.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          )}
        </Space>
      </div>
    </UploadDropZone>
  );
}

function useReceiptUploads(): {
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
        if (settlement.status !== 'failed') {
          void queryClient.invalidateQueries({ queryKey: receiptKeys.all });
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [describeError, message, patch, queryClient, t]);

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

function ReceiptUploadPanel({
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
            icon={<CloseOutlined />}
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

function ReceiptThumbnail({ receipt }: { receipt: ReceiptListItemDto }) {
  const image = useQuery({
    queryKey: receiptKeys.artifact(receipt.id, 'thumbnail'),
    queryFn: () => receiptApi.thumbnail(receipt.id),
    enabled: receipt.previewStatus === 'DONE',
    staleTime: 5 * 60 * 1000,
  });
  if (image.data === undefined) {
    return (
      <div className="receipt-thumb-placeholder">
        <FileImageOutlined />
      </div>
    );
  }
  return (
    <Image
      preview={false}
      src={image.data.url}
      alt=""
      width={52}
      height={64}
      style={{ objectFit: 'cover', borderRadius: 4 }}
    />
  );
}

function ReceiptStatus({ receipt }: { receipt: ReceiptListItemDto }) {
  const t = useTranslations('receipts');
  if (receipt.processingError !== null) return <Tag color="error">{t('failed')}</Tag>;
  if (receipt.processing) return <Tag color="processing">{t('processing')}</Tag>;
  return null;
}

function vendorOf(receipt: ReceiptListItemDto): string | null {
  return stringValue(receipt, 'vendor');
}

function stringValue(receipt: ReceiptListItemDto, key: string): string | null {
  const value = receipt.extracted?.values[key];
  return typeof value === 'string' ? value : null;
}

export function moneyValue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('amount' in value) || !('currency' in value)) return null;
  if (typeof value.amount !== 'number' || typeof value.currency !== 'string') return null;
  return `${value.amount.toLocaleString()} ${value.currency}`;
}
