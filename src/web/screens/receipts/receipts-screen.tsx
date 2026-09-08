'use client';

import { FileImageOutlined, PlusOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Empty, Image, Space, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useRef } from 'react';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { UploadDropZone } from '../../features/document-upload';
import { useErrorMessage } from '../../shared/lib';

const LIVE_REFRESH_MS = 5000;

export function ReceiptsScreen() {
  const t = useTranslations('receipts');
  const format = useFormatter();
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
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
  const { mutate: uploadFile, isPending: uploadIsPending } = useMutation({
    mutationFn: (file: File) => receiptApi.upload(file),
    onSuccess: (result) => {
      void message.success(result.created ? t('uploaded') : t('duplicate'));
      void queryClient.invalidateQueries({ queryKey: receiptKeys.all });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
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
    <UploadDropZone onFiles={uploadFile} hint={t('dropHint')}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: 24 }}>
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
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
              loading={uploadIsPending}
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
                for (const file of files) uploadFile(file);
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
