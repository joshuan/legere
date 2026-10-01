'use client';

import { FileImageOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Image, Modal, Spin, Typography } from 'antd';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type {
  ReceiptDuplicatePair,
  ReceiptMatchConflict,
} from '../../../shared/contracts/receipt-duplicates';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { moneyValue, receiptApi, receiptKeys, stringValue, vendorOf } from '../../entities/receipt';
import { QueryError } from '../../shared/ui';

const FIELDS: ReadonlyArray<{ key: string; reasons: ReceiptMatchConflict[] }> = [
  { key: 'total', reasons: ['total', 'currency'] },
  { key: 'purchasedAt', reasons: ['date'] },
  { key: 'purchasedTime', reasons: ['time'] },
  { key: 'receiptNumber', reasons: ['number'] },
  { key: 'vendorTaxId', reasons: ['taxId'] },
  { key: 'card', reasons: ['card'] },
  { key: 'paymentMethod', reasons: [] },
  { key: 'taxAmount', reasons: [] },
  { key: 'statementDescriptor', reasons: [] },
  { key: 'vendorAddress', reasons: [] },
  { key: 'city', reasons: [] },
  { key: 'country', reasons: [] },
];

export function ReceiptComparison({ pair }: { pair: ReceiptDuplicatePair }) {
  const t = useTranslations('receiptDuplicates');
  const tr = useTranslations('receipts');
  const locale = useLocale();
  const [originals, setOriginals] = useState(false);
  const receipts = [pair.first, pair.second];
  function status(reasons: ReceiptMatchConflict[]) {
    return reasons.some((reason) => pair.conflicts.includes(reason))
      ? 'conflict'
      : pair.reasons.some((reason) => reasons.includes(reason))
        ? 'match'
        : 'unknown';
  }
  function value(receipt: ReceiptListItemDto, key: string) {
    return (
      (key === 'total' || key === 'taxAmount'
        ? moneyValue(receipt.extracted?.values[key], locale)
        : stringValue(receipt, key)) ?? '—'
    );
  }
  const itemLists = receipts.map(itemsOf);
  return (
    <div className="receipt-comparison-grid">
      <div className="receipt-desktop-preview">
        <ReceiptPreview receipt={pair.first} side={1} />
      </div>
      <section className="receipt-comparison-data" aria-label={t('comparison')}>
        <div className="receipt-comparison-legend">
          <span>
            <span className="receipt-match-symbol" aria-hidden>
              ✓
            </span>{' '}
            {t('matches')}
          </span>
          <span>
            <span className="receipt-conflict-symbol" aria-hidden>
              ≠
            </span>{' '}
            {t('conflicts')}
          </span>
          <Button
            className="receipt-open-originals"
            icon={<FileImageOutlined aria-hidden />}
            onClick={() => setOriginals(true)}
          >
            {t('originals')}
          </Button>
        </div>
        <div className="receipt-facts-scroll">
          <table className="receipt-comparison-facts">
            <caption className="visually-hidden">{t('comparison')}</caption>
            <colgroup>
              <col className="receipt-fact-label" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('field')}</th>
                {receipts.map((receipt, index) => (
                  <th
                    key={receipt.id}
                    scope="col"
                    className={`receipt-fact-${status(['merchant'])}`}
                  >
                    <span className="receipt-side-label">{t('receipt', { side: index + 1 })}</span>
                    <Link
                      href={`/receipts/${receipt.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {vendorOf(receipt) ?? tr('unknownVendor')}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FIELDS.map(({ key, reasons }) => {
                const state = status(reasons);
                return (
                  <tr key={key} className={`receipt-fact-${state}`} data-fact={key}>
                    <th scope="row">
                      {tr(`fields.${key}`)}
                      {state !== 'unknown' && (
                        <span
                          role="img"
                          aria-label={t(state === 'match' ? 'matches' : 'conflicts')}
                          className={`receipt-${state}-symbol`}
                        >
                          {state === 'match' ? '✓' : '≠'}
                        </span>
                      )}
                    </th>
                    {receipts.map((receipt) => (
                      <td key={receipt.id}>{value(receipt, key)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className={`receipt-item-summary receipt-fact-${status(['items'])}`}>
          <strong>{tr('fields.items')}</strong>
          <span>
            {t('itemCounts', {
              first: itemLists[0]?.length ?? 0,
              second: itemLists[1]?.length ?? 0,
            })}
          </span>
          {pair.conflicts.includes('items') && (
            <span className="receipt-conflict-symbol">≠ {t('itemDifferences')}</span>
          )}
        </div>
        <div className="receipt-comparison-item-columns">
          {itemLists.map((items, side) => (
            <div
              key={receipts[side]?.id}
              className="receipt-items-scroll"
              role="region"
              tabIndex={0}
              aria-label={t('itemsFor', { side: side + 1 })}
            >
              {items.length === 0 ? (
                <Typography.Text type="secondary">{t('noItems')}</Typography.Text>
              ) : (
                <ul className="receipt-comparison-items">
                  {items.map((item, index) => (
                    // Immutable extracted lines may legitimately repeat.
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
            </div>
          ))}
        </div>
      </section>
      <div className="receipt-desktop-preview">
        <ReceiptPreview receipt={pair.second} side={2} />
      </div>
      <Modal
        open={originals}
        onCancel={() => setOriginals(false)}
        title={t('originals')}
        footer={null}
        width={1000}
        className="receipt-originals-modal"
        destroyOnHidden
      >
        <div className="receipt-originals-pair">
          <ReceiptPreview receipt={pair.first} side={1} />
          <ReceiptPreview receipt={pair.second} side={2} />
        </div>
      </Modal>
    </div>
  );
}

function itemsOf(receipt: ReceiptListItemDto) {
  const rows = receipt.extracted?.values.items;
  return Array.isArray(rows)
    ? rows.filter(
        (item: unknown): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}

function ReceiptPreview({ receipt, side }: { receipt: ReceiptListItemDto; side: 1 | 2 }) {
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
  return (
    <section className="receipt-comparison-preview-panel" aria-label={t('receipt', { side })}>
      <div className="receipt-preview-heading">
        <strong>{t('receipt', { side })}</strong>
        <span>
          {t('fileSize', {
            size: (Number(receipt.sizeBytes) / 1024).toLocaleString(locale, {
              maximumFractionDigits: 0,
            }),
          })}
        </span>
      </div>
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
      <div className="receipt-preview-file" title={receipt.fileName}>
        {receipt.fileName}
      </div>
      {(receipt.pageCount ?? 1) > 1 && (
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
      )}
    </section>
  );
}
