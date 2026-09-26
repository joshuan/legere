'use client';

import { FileImageOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Image, Tag } from 'antd';
import { useTranslations } from 'next-intl';
import { type ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { receiptApi, receiptKeys } from './api';

export function ReceiptThumbnail({ receipt }: { receipt: ReceiptListItemDto }) {
  const image = useQuery({
    queryKey: receiptKeys.artifact(receipt.id, 'thumbnail'),
    queryFn: () => receiptApi.thumbnail(receipt.id),
    enabled: receipt.previewStatus === 'DONE',
    staleTime: 5 * 60 * 1000,
  });
  if (image.data === undefined) {
    return (
      <div className="receipt-thumb-placeholder">
        <FileImageOutlined aria-hidden />
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

export function ReceiptStatus({ receipt }: { receipt: ReceiptListItemDto }) {
  const t = useTranslations('receipts');
  if (receipt.processingError !== null) return <Tag color="error">{t('failed')}</Tag>;
  if (receipt.processing) return <Tag color="processing">{t('processing')}</Tag>;
  return null;
}

export function vendorOf(receipt: ReceiptListItemDto): string | null {
  return stringValue(receipt, 'vendor');
}

export function stringValue(receipt: ReceiptListItemDto, key: string): string | null {
  const value = receipt.extracted?.values[key];
  return typeof value === 'string' ? value : null;
}

export function itemCount(receipt: ReceiptListItemDto): number | null {
  const items = receipt.extracted?.values.items;
  return Array.isArray(items) ? items.length : null;
}

export function receiptTaxValue(receipt: ReceiptListItemDto, locale: string): string | null {
  const tax = receipt.extracted?.values.taxAmount;
  if (typeof tax !== 'number') return null;
  const total = receipt.extracted?.values.total;
  if (typeof total !== 'object' || total === null || Array.isArray(total)) return String(tax);
  const currency = 'currency' in total ? total.currency : null;
  return typeof currency === 'string' ? `${tax.toLocaleString(locale)} ${currency}` : String(tax);
}
