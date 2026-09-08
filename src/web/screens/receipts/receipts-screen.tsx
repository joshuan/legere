'use client';

import { CloseOutlined, FileImageOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Image,
  Input,
  InputNumber,
  Progress,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RECEIPT_SORT,
  RECEIPT_SORTS,
  receiptFiltersSchema,
  receiptSortSchema,
  type ReceiptFilters,
  type ReceiptListItemDto,
  type ReceiptSort,
} from '../../../shared/contracts/receipts';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { UploadDropZone } from '../../features/document-upload';
import { useErrorMessage } from '../../shared/lib';

const LIVE_REFRESH_MS = 5000;

type ReceiptsView = { filters: ReceiptFilters; sort: ReceiptSort };

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const view = useMemo(() => parseReceiptsView(searchParams), [searchParams]);
  const { filters, sort } = view;
  const setView = useCallback(
    (patch: Partial<ReceiptsView>) => {
      const next = { ...view, ...patch };
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(next.filters)) {
        if (value !== undefined) params.set(key, String(value));
      }
      if (next.sort !== DEFAULT_RECEIPT_SORT) params.set('sort', next.sort);
      const query = params.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`);
    },
    [pathname, router, view],
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
      width: 130,
      render: (_, receipt) => moneyValue(receipt.extracted?.values.total) ?? '—',
    },
    {
      title: t('fields.taxAmount'),
      key: 'tax',
      width: 110,
      render: (_, receipt) => receiptTaxValue(receipt) ?? '—',
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
      <div style={{ width: '100%', padding: 24 }}>
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

          <Space wrap size="middle">
            <ReceiptFiltersBar value={filters} onChange={(next) => setView({ filters: next })} />
            <Select<ReceiptSort>
              style={{ minWidth: 220 }}
              aria-label={t('sort.label')}
              value={sort}
              onChange={(next) => setView({ sort: next })}
              options={RECEIPT_SORTS.map((option) => ({
                value: option,
                label: t(`sort.options.${option}`),
              }))}
            />
          </Space>

          {receipts.isLoading ? (
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
                <Table
                  rowKey="id"
                  columns={columns}
                  dataSource={items}
                  pagination={false}
                  scroll={{ x: 1600 }}
                />
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

function ReceiptFiltersBar({
  value,
  onChange,
}: {
  value: ReceiptFilters;
  onChange: (next: ReceiptFilters) => void;
}) {
  const t = useTranslations('receipts');
  const locale = useLocale();
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const currencies = useMemo(currencyOptions, []);

  const set = (patch: Partial<ReceiptFilters>): void => {
    const merged = { ...value, ...patch };
    const next: ReceiptFilters = {};
    if (merged.q !== undefined) next.q = merged.q;
    if (merged.purchasedFrom !== undefined) next.purchasedFrom = merged.purchasedFrom;
    if (merged.purchasedTo !== undefined) next.purchasedTo = merged.purchasedTo;
    if (merged.country !== undefined) next.country = merged.country;
    if (merged.currency !== undefined) next.currency = merged.currency;
    if (merged.amountMin !== undefined) next.amountMin = merged.amountMin;
    if (merged.amountMax !== undefined) next.amountMax = merged.amountMax;
    onChange(next);
  };

  const range: [Dayjs | null, Dayjs | null] | null =
    value.purchasedFrom === undefined && value.purchasedTo === undefined
      ? null
      : [
          value.purchasedFrom === undefined ? null : dayjs(value.purchasedFrom),
          value.purchasedTo === undefined ? null : dayjs(value.purchasedTo),
        ];

  return (
    <Space wrap size="middle">
      <Input
        allowClear
        type="search"
        prefix={<SearchOutlined />}
        style={{ width: 230 }}
        aria-label={t('filters.vendor')}
        placeholder={t('filters.vendor')}
        value={value.q ?? ''}
        onChange={(event) => {
          const q = event.currentTarget.value.trimStart();
          set({ q: q === '' ? undefined : q });
        }}
      />
      <DatePicker.RangePicker
        allowEmpty={[true, true]}
        aria-label={t('filters.purchaseDates')}
        placeholder={[t('filters.dateFrom'), t('filters.dateTo')]}
        value={range}
        onChange={(dates) =>
          set({
            purchasedFrom: dates?.[0]?.format('YYYY-MM-DD'),
            purchasedTo: dates?.[1]?.format('YYYY-MM-DD'),
          })
        }
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ minWidth: 170 }}
        aria-label={t('filters.country')}
        placeholder={t('filters.country')}
        value={value.country}
        options={countries}
        onChange={(country?: string) => set({ country })}
      />
      <Select
        allowClear
        showSearch
        style={{ width: 130 }}
        aria-label={t('filters.currency')}
        placeholder={t('filters.currency')}
        value={value.currency}
        options={currencies.map((currency) => ({ value: currency, label: currency }))}
        onChange={(currency?: string) => set({ currency })}
      />
      <InputNumber<number>
        controls={false}
        style={{ width: 155 }}
        aria-label={t('filters.amountMin')}
        placeholder={t('filters.amountMin')}
        value={value.amountMin ?? null}
        onChange={(amountMin) => set({ amountMin: amountMin ?? undefined })}
      />
      <InputNumber<number>
        controls={false}
        style={{ width: 155 }}
        aria-label={t('filters.amountMax')}
        placeholder={t('filters.amountMax')}
        value={value.amountMax ?? null}
        onChange={(amountMax) => set({ amountMax: amountMax ?? undefined })}
      />
      {Object.keys(value).length > 0 && (
        <Button onClick={() => onChange({})}>{t('filters.clear')}</Button>
      )}
    </Space>
  );
}

function parseReceiptsView(params: URLSearchParams): ReceiptsView {
  const filters: ReceiptFilters = {};
  const q = receiptFiltersSchema.shape.q.safeParse(params.get('q') ?? undefined);
  if (q.success && q.data !== undefined) filters.q = q.data;
  const purchasedFrom = receiptFiltersSchema.shape.purchasedFrom.safeParse(
    params.get('purchasedFrom') ?? undefined,
  );
  if (purchasedFrom.success && purchasedFrom.data !== undefined) {
    filters.purchasedFrom = purchasedFrom.data;
  }
  const purchasedTo = receiptFiltersSchema.shape.purchasedTo.safeParse(
    params.get('purchasedTo') ?? undefined,
  );
  if (purchasedTo.success && purchasedTo.data !== undefined) filters.purchasedTo = purchasedTo.data;
  const country = receiptFiltersSchema.shape.country.safeParse(params.get('country') ?? undefined);
  if (country.success && country.data !== undefined) filters.country = country.data;
  const currency = receiptFiltersSchema.shape.currency.safeParse(
    params.get('currency') ?? undefined,
  );
  if (currency.success && currency.data !== undefined) filters.currency = currency.data;
  const amountMin = receiptFiltersSchema.shape.amountMin.safeParse(
    params.get('amountMin') ?? undefined,
  );
  if (amountMin.success && amountMin.data !== undefined) filters.amountMin = amountMin.data;
  const amountMax = receiptFiltersSchema.shape.amountMax.safeParse(
    params.get('amountMax') ?? undefined,
  );
  if (amountMax.success && amountMax.data !== undefined) filters.amountMax = amountMax.data;
  const parsedSort = receiptSortSchema.safeParse(params.get('sort'));
  return {
    filters,
    sort: parsedSort.success ? parsedSort.data : DEFAULT_RECEIPT_SORT,
  };
}

function countryOptions(locale: string): Array<{ value: string; label: string }> {
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const options: Array<{ value: string; label: string }> = [];
    for (const first of letters) {
      for (const second of letters) {
        const code = `${first}${second}`;
        const label = names.of(code) ?? code;
        if (label !== code) options.push({ value: code, label });
      }
    }
    return options.sort((left, right) => left.label.localeCompare(right.label, locale));
  } catch {
    return [];
  }
}

function currencyOptions(): string[] {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['BAM', 'EUR', 'GBP', 'RSD', 'RUB', 'USD'];
  }
}

function useReceiptUploads(refreshNewReceipts: boolean): {
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

function itemCount(receipt: ReceiptListItemDto): number | null {
  const items = receipt.extracted?.values.items;
  return Array.isArray(items) ? items.length : null;
}

function receiptTaxValue(receipt: ReceiptListItemDto): string | null {
  const tax = receipt.extracted?.values.taxAmount;
  if (typeof tax !== 'number') return null;
  const total = receipt.extracted?.values.total;
  if (typeof total !== 'object' || total === null || Array.isArray(total)) return String(tax);
  const currency = 'currency' in total ? total.currency : null;
  return typeof currency === 'string' ? `${tax.toLocaleString()} ${currency}` : String(tax);
}

export function moneyValue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('amount' in value) || !('currency' in value)) return null;
  if (typeof value.amount !== 'number' || typeof value.currency !== 'string') return null;
  return `${value.amount.toLocaleString()} ${value.currency}`;
}
