'use client';

import { useQuery } from '@tanstack/react-query';
import { Button, Card, Image, Space, Spin, Typography } from 'antd';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { moneyValue, receiptApi, receiptKeys, stringValue, vendorOf } from '../../entities/receipt';
import { QueryError } from '../../shared/ui';

const FIELDS = [
  'purchasedAt',
  'purchasedTime',
  'vendorTaxId',
  'receiptNumber',
  'statementDescriptor',
  'card',
] as const;

export function ReceiptComparison({ receipt, side }: { receipt: ReceiptListItemDto; side: 1 | 2 }) {
  const t = useTranslations('receiptDuplicates');
  const tr = useTranslations('receipts');
  const locale = useLocale();
  const [page, setPage] = useState(0);
  const preview = useQuery({
    queryKey: receiptKeys.artifact(receipt.id, `page-${page}`),
    queryFn: () => receiptApi.page(receipt.id, page),
    enabled: receipt.previewStatus === 'DONE',
    staleTime: 5 * 60 * 1000,
  });
  const rows = receipt.extracted?.values.items;
  const items = Array.isArray(rows)
    ? rows.filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
  return (
    <Card
      className="receipt-comparison"
      title={
        <div>
          <Typography.Text type="secondary">{t('receipt', { side })}</Typography.Text>
          <div>
            <Link href={`/receipts/${receipt.id}`} target="_blank" rel="noopener noreferrer">
              {vendorOf(receipt) ?? tr('unknownVendor')}
            </Link>
          </div>
        </div>
      }
    >
      <div className="receipt-comparison-preview">
        {preview.isLoading ? (
          <Spin />
        ) : preview.isError ? (
          <QueryError error={preview.error} retry={preview.refetch} />
        ) : preview.data === undefined ? (
          <Typography.Text type="secondary">{tr('previewUnavailable')}</Typography.Text>
        ) : (
          <Image
            styles={{
              root: { height: '100%', width: '100%' },
              image: { height: '100%', width: '100%', objectFit: 'contain' },
            }}
            src={preview.data.url}
            alt={tr('pageAlt', { fileName: receipt.fileName, page: page + 1 })}
          />
        )}
      </div>
      <div className="receipt-comparison-pages">
        <Button
          aria-label={t('previousPage', { side })}
          disabled={page === 0}
          onClick={() => setPage((value) => value - 1)}
        >
          ←
        </Button>
        <Typography.Text>
          {t('page', { page: page + 1, total: receipt.pageCount ?? 1 })}
        </Typography.Text>
        <Button
          aria-label={t('nextPage', { side })}
          disabled={page + 1 >= (receipt.pageCount ?? 1)}
          onClick={() => setPage((value) => value + 1)}
        >
          →
        </Button>
      </div>
      <dl className="receipt-comparison-facts">
        <div className="receipt-comparison-total">
          <dt>{tr('fields.total')}</dt>
          <dd>{moneyValue(receipt.extracted?.values.total, locale) ?? '—'}</dd>
        </div>
        {FIELDS.map((field) => (
          <div key={field}>
            <dt>{tr(`fields.${field}`)}</dt>
            <dd>{stringValue(receipt, field) ?? '—'}</dd>
          </div>
        ))}
        <div>
          <dt>{tr('file')}</dt>
          <dd>{receipt.fileName}</dd>
        </div>
        <div>
          <dt>{tr('size')}</dt>
          <dd>
            {t('fileSize', {
              size: (Number(receipt.sizeBytes) / 1024).toLocaleString(locale, {
                maximumFractionDigits: 0,
              }),
            })}
          </dd>
        </div>
      </dl>
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text strong>
          {tr('fields.items')} · {items.length}
        </Typography.Text>
        {items.length === 0 ? (
          <Typography.Text type="secondary">{t('noItems')}</Typography.Text>
        ) : (
          <ul className="receipt-comparison-items">
            {items.map((item, index) => (
              // Extracted rows are an immutable snapshot; identical item lines can repeat.
              // eslint-disable-next-line @eslint-react/no-array-index-key
              <li key={index}>
                <span>
                  {typeof item.name === 'string' ? item.name : '—'}
                  {typeof item.quantity === 'number'
                    ? ` × ${item.quantity.toLocaleString(locale)}`
                    : ''}
                </span>
                <span>
                  {typeof item.amount === 'number' ? item.amount.toLocaleString(locale) : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Space>
    </Card>
  );
}
