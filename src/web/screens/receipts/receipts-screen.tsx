'use client';

import { CopyOutlined, PlusOutlined } from '@ant-design/icons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Empty, Select, Space, Spin, Typography } from 'antd';
import { PageHeader, ResponsiveTable as Table, QueryError } from '../../shared/ui';
import type { ColumnsType } from 'antd/es/table';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RECEIPT_SORT,
  RECEIPT_SORTS,
  type ReceiptListItemDto,
  type ReceiptSort,
} from '../../../shared/contracts/receipts';
import {
  moneyValue,
  receiptApi,
  receiptKeys,
  ReceiptThumbnail,
  vendorOf,
  stringValue,
  itemCount,
  receiptTaxValue,
  ReceiptStatus,
} from '../../entities/receipt';
import { UploadDropZone } from '../../features/document-upload';
import {
  parseReceiptsView,
  type ReceiptsView,
  ReceiptFiltersBar,
} from '../../features/receipt-filters';
import { useReceiptUploads, ReceiptUploadPanel } from '../../features/receipt-upload';

const LIVE_REFRESH_MS = 5000;

export function ReceiptsScreen() {
  const t = useTranslations('receipts');
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const td = useTranslations('receiptDuplicates');
  const selecting = searchParams.get('compare') === '1';
  const [selected, setSelected] = useState<ReceiptListItemDto[]>([]);
  const unavailable = (receipt: ReceiptListItemDto) =>
    receipt.processing ||
    (!selected.some((item) => item.id === receipt.id) &&
      (selected.length >= 2 ||
        (selected[0] !== undefined && selected[0].owner.id !== receipt.owner.id)));
  const toggle = (receipt: ReceiptListItemDto, checked: boolean) =>
    setSelected((previous) =>
      checked
        ? [...previous.filter((item) => item.id !== receipt.id), receipt].slice(0, 2)
        : previous.filter((item) => item.id !== receipt.id),
    );
  const inputRef = useRef<HTMLInputElement>(null);
  const view = useMemo(() => parseReceiptsView(searchParams), [searchParams]);
  const { filters, sort } = view;
  const setView = useCallback(
    (patch: Partial<ReceiptsView>) => {
      const next = { ...view, ...patch };
      const params = new URLSearchParams();
      if (selecting) params.set('compare', '1');
      for (const [key, value] of Object.entries(next.filters)) {
        if (value !== undefined) params.set(key, String(value));
      }
      if (next.sort !== DEFAULT_RECEIPT_SORT) params.set('sort', next.sort);
      const query = params.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`);
    },
    [pathname, router, selecting, view],
  );
  const uploads = useReceiptUploads(sort === 'createdAt');
  const receipts = useInfiniteQuery({
    queryKey: receiptKeys.list(filters, sort),
    queryFn: ({ pageParam }) =>
      receiptApi.list(filters, { sort, ...(pageParam === '' ? {} : { cursor: pageParam }) }),
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
      width: 190,
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
      title: t('fields.vendorAddress'),
      key: 'address',
      width: 230,
      render: (_, receipt) =>
        stringValue(receipt, 'vendorAddress') ?? stringValue(receipt, 'city') ?? '—',
    },
    {
      title: t('fields.country'),
      key: 'country',
      width: 110,
      render: (_, receipt) => stringValue(receipt, 'country') ?? '—',
    },
    {
      title: t('fields.items'),
      key: 'items',
      width: 100,
      align: 'right',
      render: (_, receipt) => itemCount(receipt) ?? '—',
    },
    {
      title: t('fields.total'),
      key: 'total',
      align: 'right',
      width: 130,
      render: (_, receipt) => moneyValue(receipt.extracted?.values.total, locale) ?? '—',
    },
    {
      title: t('fields.taxAmount'),
      key: 'tax',
      align: 'right',
      width: 110,
      render: (_, receipt) => receiptTaxValue(receipt, locale) ?? '—',
    },
    {
      title: t('fields.paymentMethod'),
      key: 'paymentMethod',
      width: 130,
      render: (_, receipt) => {
        const method = stringValue(receipt, 'paymentMethod');
        if (method === 'card' || method === 'cash') return t(`paymentMethods.${method}`);
        return method ?? '—';
      },
    },
    {
      title: t('fields.receiptNumber'),
      key: 'receiptNumber',
      width: 150,
      render: (_, receipt) => stringValue(receipt, 'receiptNumber') ?? '—',
    },
    {
      title: t('added'),
      dataIndex: 'createdAt',
      width: 150,
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
      <div style={{ width: '100%', minWidth: 0 }}>
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
        <Space orientation="vertical" size={20} style={{ width: '100%' }}>
          {uploads.items.length > 0 && (
            <ReceiptUploadPanel items={uploads.items} busy={uploads.busy} onClose={uploads.clear} />
          )}
          <PageHeader
            title={t('title')}
            description={t('uploadHint')}
            actions={
              <Space wrap>
                <Link href="/receipts/duplicates">
                  <Button icon={<CopyOutlined aria-hidden />}>{td('find')}</Button>
                </Link>
                <Button
                  type="primary"
                  icon={<PlusOutlined aria-hidden />}
                  loading={uploads.busy}
                  onClick={() => inputRef.current?.click()}
                >
                  {t('upload')}
                </Button>
              </Space>
            }
          />

          {selecting && (
            <Alert
              type="info"
              title={td('selectHint')}
              description={
                <Space wrap>
                  <Typography.Text>{td('selected', { count: selected.length })}</Typography.Text>
                  <Button
                    type="primary"
                    disabled={selected.length !== 2}
                    onClick={() => {
                      const [first, second] = selected;
                      if (first !== undefined && second !== undefined)
                        router.push(
                          `/receipts/duplicates?firstId=${first.id}&secondId=${second.id}`,
                        );
                    }}
                  >
                    {td('compare')}
                  </Button>
                  <Link href="/receipts/duplicates">
                    <Button>{td('cancel')}</Button>
                  </Link>
                </Space>
              }
            />
          )}
          <Space wrap size="middle">
            <ReceiptFiltersBar
              compact
              value={filters}
              onChange={(next) => setView({ filters: next })}
            />
            <Select<ReceiptSort>
              style={{ width: 220, maxWidth: '100%' }}
              aria-label={t('sort.label')}
              value={sort}
              onChange={(next) => setView({ sort: next })}
              options={RECEIPT_SORTS.map((option) => ({
                value: option,
                label: t(`sort.options.${option}`),
              }))}
            />
          </Space>

          {receipts.isError && receipts.data !== undefined && (
            <QueryError error={receipts.error} retry={receipts.refetch} />
          )}
          {receipts.isError && receipts.data === undefined ? (
            <QueryError error={receipts.error} retry={receipts.refetch} />
          ) : receipts.isLoading ? (
            <div style={{ textAlign: 'center', padding: 64 }}>
              <Spin />
            </div>
          ) : items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={Object.keys(filters).length === 0 ? t('empty') : t('emptyFiltered')}
            />
          ) : (
            <>
              <div className="receipt-desktop-list">
                <Table<ReceiptListItemDto>
                  rowKey="id"
                  {...(selecting
                    ? {
                        rowSelection: {
                          selectedRowKeys: selected.map((item) => item.id),
                          hideSelectAll: true,
                          getCheckboxProps: (receipt) => ({
                            disabled: unavailable(receipt),
                            'aria-label': td('selectReceipt', { name: receipt.fileName }),
                          }),
                          onSelect: toggle,
                        },
                      }
                    : {})}
                  columns={columns}
                  dataSource={items}
                  pagination={false}
                  scroll={{ x: 1600 }}
                />
              </div>
              <div className="receipt-mobile-list">
                <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                  {items.map((receipt) => (
                    <Card key={receipt.id} size="small">
                      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                        {selecting && (
                          <Checkbox
                            aria-label={td('selectReceipt', { name: receipt.fileName })}
                            checked={selected.some((item) => item.id === receipt.id)}
                            disabled={unavailable(receipt)}
                            onChange={(event) => toggle(receipt, event.target.checked)}
                          />
                        )}
                        <Link
                          href={`/receipts/${receipt.id}`}
                          style={{ display: 'flex', gap: 14, minWidth: 0, flex: 1 }}
                        >
                          <ReceiptThumbnail receipt={receipt} />
                          <Space orientation="vertical" size={2} style={{ minWidth: 0 }}>
                            <Typography.Text strong ellipsis>
                              {vendorOf(receipt) ?? t('unknownVendor')}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              {[
                                stringValue(receipt, 'purchasedAt'),
                                stringValue(receipt, 'purchasedTime'),
                                moneyValue(receipt.extracted?.values.total, locale),
                              ]
                                .filter((value) => value !== null)
                                .join(' · ') || receipt.fileName}
                            </Typography.Text>
                            <ReceiptStatus receipt={receipt} />
                          </Space>
                        </Link>
                      </div>
                    </Card>
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
