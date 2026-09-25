'use client';

import {
  ArrowLeftOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Image,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { moneyValue, receiptApi, receiptKeys } from '../../entities/receipt';
import { formatBytes, useErrorMessage } from '../../shared/lib';
import { QueryError } from '../../shared/ui';

const SCALAR_KEYS = [
  'vendor',
  'vendorAddress',
  'country',
  'city',
  'statementDescriptor',
  'purchasedAt',
  'purchasedTime',
  'total',
  'taxAmount',
  'paymentMethod',
  'card',
  'vendorTaxId',
  'receiptNumber',
] as const;

export function ReceiptViewerScreen({ id }: { id: string }) {
  const t = useTranslations('receipts');
  const format = useFormatter();
  const router = useRouter();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message, modal } = App.useApp();
  const receipt = useQuery({
    queryKey: receiptKeys.detail(id),
    queryFn: () => receiptApi.get(id),
    refetchInterval: (query) => (query.state.data?.processing ? 5000 : false),
  });
  const remove = useMutation({
    mutationFn: () => receiptApi.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: receiptKeys.all });
      void message.success(t('deleted'));
      router.replace('/receipts');
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });
  const convert = useMutation({
    mutationFn: () => receiptApi.convert(id, 'DOCUMENT'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: receiptKeys.all });
      router.replace(`/documents/${id}`);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  if (receipt.isError && receipt.data === undefined)
    return <QueryError error={receipt.error} retry={receipt.refetch} />;
  if (receipt.isLoading || receipt.data === undefined) {
    return (
      <div style={{ padding: 64, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }
  const data = receipt.data;
  const raw = data.extracted === null ? null : JSON.stringify(data.extracted, null, 2);

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', width: '100%', minWidth: 0 }}>
      {receipt.isError && <QueryError error={receipt.error} retry={receipt.refetch} />}
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <div
          style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}
        >
          <Space direction="vertical" size={2}>
            <Link href="/receipts">
              <ArrowLeftOutlined aria-hidden /> {t('back')}
            </Link>
            <Typography.Title level={2} style={{ margin: 0 }}>
              {textValue(data.extracted?.values.vendor) ?? t('unknownVendor')}
            </Typography.Title>
            <Typography.Text type="secondary">{data.fileName}</Typography.Text>
          </Space>
          <Space wrap>
            {data.processing && <Tag color="processing">{t('processing')}</Tag>}
            <Button
              icon={<DownloadOutlined aria-hidden />}
              onClick={() => {
                void receiptApi
                  .download(id)
                  .then(({ url }) => window.location.assign(url))
                  .catch((error: unknown) => message.error(describeError(error)));
              }}
            >
              {t('downloadOriginal')}
            </Button>
            <Button
              icon={<FileTextOutlined aria-hidden />}
              loading={convert.isPending}
              disabled={data.processing}
              onClick={() => {
                modal.confirm({
                  title: t('moveToDocuments'),
                  content: t('moveToDocumentsConfirm'),
                  okText: t('moveToDocuments'),
                  onOk: () => convert.mutate(),
                });
              }}
            >
              {t('moveToDocuments')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined aria-hidden />}
              loading={remove.isPending}
              onClick={() => {
                modal.confirm({
                  title: t('delete'),
                  content: t('deleteConfirm'),
                  okButtonProps: { danger: true },
                  okText: t('delete'),
                  onOk: () => remove.mutate(),
                });
              }}
            >
              {t('delete')}
            </Button>
          </Space>
        </div>

        {data.processingError !== null && (
          <Alert type="error" showIcon message={t('failed')} description={data.processingError} />
        )}

        <Row gutter={[18, 18]} align="top">
          <Col xs={24} lg={13}>
            <Card styles={{ body: { padding: 12 } }}>
              <ReceiptImages
                id={id}
                mimeType={data.mimeType}
                pageCount={data.pageCount}
                ready={data.previewStatus === 'DONE'}
                processing={data.processing}
                fileName={data.fileName}
              />
            </Card>
          </Col>
          <Col xs={24} lg={11}>
            <Space direction="vertical" size={18} style={{ width: '100%' }}>
              <Card title={t('details')}>
                {data.extracted === null ? (
                  <Typography.Text type="secondary">{t('noData')}</Typography.Text>
                ) : (
                  <ReceiptFields values={data.extracted.values} />
                )}
              </Card>
              <Card title={t('file')}>
                <Descriptions column={1} size="small">
                  <Descriptions.Item label={t('file')}>{data.fileName}</Descriptions.Item>
                  <Descriptions.Item label={t('pageCount')}>
                    {data.pageCount === null ? '—' : t('pages', { count: data.pageCount })}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('owner')}>{data.owner.displayName}</Descriptions.Item>
                  <Descriptions.Item label={t('added')}>
                    {format.dateTime(new Date(data.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('size')}>
                    {formatBytes(data.sizeBytes)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('previewStep')}>
                    {t(`statuses.${data.previewStatus}`)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('extractionStep')}>
                    {t(`statuses.${data.extractionStatus}`)}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
              <Card
                title={t('raw')}
                extra={
                  <Space>
                    <Button
                      size="small"
                      icon={<CopyOutlined aria-hidden />}
                      disabled={raw === null}
                      onClick={() => {
                        if (raw === null) return;
                        void Promise.resolve()
                          .then(() => navigator.clipboard.writeText(raw))
                          .then(() => message.success(t('copied')))
                          .catch(() => message.error(t('copyFailed')));
                      }}
                    >
                      {t('copyJson')}
                    </Button>
                    <Button
                      size="small"
                      icon={<DownloadOutlined aria-hidden />}
                      disabled={raw === null}
                      onClick={() => {
                        if (raw !== null) downloadJson(raw, `receipt-${id}.json`);
                      }}
                    >
                      {t('downloadJson')}
                    </Button>
                  </Space>
                }
              >
                <pre className="receipt-json">{raw ?? t('noData')}</pre>
              </Card>
              {data.sourceText !== null && (
                <Collapse
                  items={[
                    {
                      key: 'source-text',
                      label: t('sourceText'),
                      extra: (
                        <Typography.Text type="secondary">{t('sourceTextHint')}</Typography.Text>
                      ),
                      children: <pre className="receipt-json">{data.sourceText}</pre>,
                    },
                  ]}
                />
              )}
            </Space>
          </Col>
        </Row>
      </Space>
    </div>
  );
}

function ReceiptImages({
  id,
  mimeType,
  pageCount,
  ready,
  processing,
  fileName,
}: {
  id: string;
  mimeType: string;
  pageCount: number | null;
  ready: boolean;
  processing: boolean;
  fileName: string;
}) {
  const t = useTranslations('receipts');
  const original = useQuery({
    queryKey: receiptKeys.artifact(id, 'original'),
    queryFn: () => receiptApi.original(id),
    enabled: ready && mimeType.startsWith('image/'),
    staleTime: 5 * 60 * 1000,
  });
  const pageQueries = useQueries({
    queries: Array.from(
      { length: ready && mimeType === 'application/pdf' ? (pageCount ?? 0) : 0 },
      (_, page) => ({
        queryKey: receiptKeys.artifact(id, `page-${page}`),
        queryFn: () => receiptApi.page(id, page),
        staleTime: 5 * 60 * 1000,
      }),
    ),
  });

  if (!ready) {
    return (
      <Typography.Text type="secondary">
        {processing ? t('processing') : t('previewUnavailable')}
      </Typography.Text>
    );
  }
  if (mimeType.startsWith('image/')) {
    if (original.isError) return <QueryError error={original.error} retry={original.refetch} />;
    if (original.data === undefined) return <Spin />;
    return (
      <Image
        src={original.data.url}
        alt={fileName}
        style={{ width: '100%', maxHeight: '78vh', objectFit: 'contain' }}
      />
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {pageQueries.map((page, index) =>
        page.isError ? (
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <QueryError key={index} error={page.error} retry={page.refetch} />
        ) : page.data === undefined ? (
          // A receipt page's index is its stable identity inside the immutable original PDF.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <Spin key={index} />
        ) : (
          <Image
            // eslint-disable-next-line @eslint-react/no-array-index-key
            key={index}
            src={page.data.url}
            alt={t('pageAlt', { page: index + 1, fileName })}
            style={{ width: '100%' }}
          />
        ),
      )}
    </Space>
  );
}

function ReceiptFields({ values }: { values: Record<string, unknown> }) {
  const t = useTranslations('receipts');
  const locale = useLocale();
  const items = arrayValue(values.items);
  const descriptions = SCALAR_KEYS.flatMap((key) => {
    const value = values[key];
    if (value === undefined || value === null) return [];
    return [
      <Descriptions.Item key={key} label={t(`fields.${key}`)}>
        {key === 'paymentMethod' && (value === 'card' || value === 'cash')
          ? t(`paymentMethods.${value}`)
          : displayValue(value, locale)}
      </Descriptions.Item>,
    ];
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions column={1} size="small">
        {descriptions}
      </Descriptions>
      {items.length > 0 && <ReceiptItems rows={items} />}
    </Space>
  );
}

function ReceiptItems({ rows }: { rows: Record<string, unknown>[] }) {
  const t = useTranslations('receipts');
  const locale = useLocale();
  const data = rows.map((values, index) => ({ key: String(index), values }));
  const columns: ColumnsType<(typeof data)[number]> = [
    { title: t('fields.name'), render: (_, row) => displayValue(row.values.name, locale) },
    {
      title: t('fields.quantity'),
      width: 90,
      render: (_, row) => displayValue(row.values.quantity, locale),
    },
    {
      title: t('fields.unitPrice'),
      width: 100,
      render: (_, row) => displayValue(row.values.unitPrice, locale),
    },
    {
      title: t('fields.amount'),
      width: 100,
      render: (_, row) => displayValue(row.values.amount, locale),
    },
    {
      title: t('fields.discount'),
      width: 90,
      render: (_, row) => displayValue(row.values.discount, locale),
    },
    {
      title: t('fields.taxCode'),
      width: 90,
      render: (_, row) => displayValue(row.values.taxCode, locale),
    },
    {
      title: t('fields.taxRate'),
      width: 90,
      render: (_, row) => displayValue(row.values.taxRate, locale),
    },
    {
      title: t('fields.taxAmount'),
      width: 100,
      render: (_, row) => displayValue(row.values.taxAmount, locale),
    },
  ];
  return (
    <div>
      <Typography.Title level={5}>{t('fields.items')}</Typography.Title>
      <Table
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={data}
        pagination={false}
        scroll={{ x: 840 }}
      />
    </div>
  );
}

function displayValue(value: unknown, locale: string): ReactNode {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return moneyValue(value, locale) ?? JSON.stringify(value);
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function downloadJson(json: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
