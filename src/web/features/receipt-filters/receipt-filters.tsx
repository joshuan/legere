'use client';

import { ControlPopover } from '../../shared/ui';
import { FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, DatePicker, Input, InputNumber, Select, Space } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import {
  DEFAULT_RECEIPT_SORT,
  receiptFiltersSchema,
  receiptSortSchema,
  type ReceiptFilters,
  type ReceiptSort,
} from '../../../shared/contracts/receipts';

export type ReceiptsView = { filters: ReceiptFilters; sort: ReceiptSort };

export function ReceiptFiltersBar({
  value,
  onChange,
  compact = false,
}: {
  compact?: boolean;
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

  const advanced = (
    <Space wrap size="middle" className={compact ? 'legere-filter-panel' : ''}>
      <div className={compact ? 'legere-control-field' : undefined}>
        {compact && <span className="legere-control-label">{t('filters.purchaseDates')}</span>}
        <DatePicker.RangePicker
          style={{ width: compact ? '100%' : undefined }}
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
      </div>
      <div className={compact ? 'legere-control-field' : undefined}>
        {compact && <span className="legere-control-label">{t('filters.country')}</span>}
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: compact ? '100%' : 170, maxWidth: '100%' }}
          aria-label={t('filters.country')}
          placeholder={t('filters.country')}
          value={value.country}
          options={countries}
          onChange={(country?: string) => set({ country })}
        />
      </div>
      <div className={compact ? 'legere-control-field' : undefined}>
        {compact && <span className="legere-control-label">{t('filters.currency')}</span>}
        <Select
          allowClear
          showSearch
          style={{ width: compact ? '100%' : 130 }}
          aria-label={t('filters.currency')}
          placeholder={t('filters.currency')}
          value={value.currency}
          options={currencies.map((currency) => ({ value: currency, label: currency }))}
          onChange={(currency?: string) => set({ currency })}
        />
      </div>
      <div className={compact ? 'legere-control-field' : undefined}>
        {compact && <span className="legere-control-label">{t('filters.amountMin')}</span>}
        <InputNumber<number>
          controls={false}
          style={{ width: compact ? '100%' : 155 }}
          aria-label={t('filters.amountMin')}
          placeholder={t('filters.amountMin')}
          value={value.amountMin ?? null}
          onChange={(amountMin) => set({ amountMin: amountMin ?? undefined })}
        />
      </div>
      <div className={compact ? 'legere-control-field' : undefined}>
        {compact && <span className="legere-control-label">{t('filters.amountMax')}</span>}
        <InputNumber<number>
          controls={false}
          style={{ width: compact ? '100%' : 155 }}
          aria-label={t('filters.amountMax')}
          placeholder={t('filters.amountMax')}
          value={value.amountMax ?? null}
          onChange={(amountMax) => set({ amountMax: amountMax ?? undefined })}
        />
      </div>
      {Object.keys(value).length > 0 && (
        <Button onClick={() => onChange({})}>{t('filters.clear')}</Button>
      )}
    </Space>
  );

  return (
    <Space wrap size="middle">
      <Input
        allowClear
        type="search"
        prefix={<SearchOutlined aria-hidden />}
        style={{ width: 230 }}
        aria-label={t('filters.vendor')}
        placeholder={t('filters.vendor')}
        value={value.q ?? ''}
        onChange={(event) => {
          const q = event.currentTarget.value.trimStart();
          set({ q: q === '' ? undefined : q });
        }}
      />
      {compact ? (
        <ControlPopover
          label={t('filters.title')}
          icon={<FilterOutlined />}
          count={Object.keys(value).length}
        >
          {advanced}
        </ControlPopover>
      ) : (
        advanced
      )}
    </Space>
  );
}

export function parseReceiptsView(params: URLSearchParams): ReceiptsView {
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
