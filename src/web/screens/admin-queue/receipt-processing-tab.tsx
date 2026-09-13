'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  InputNumber,
  Popconfirm,
  Space,
  Spin,
  Statistic,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { ProcessingSnapshotResponse } from '../../../shared/contracts/processing';
import { RECEIPT_RETRY_BATCH_SIZE } from '../../../shared/contracts/receipt-processing';
import { processingApi, processingKeys } from '../../entities/processing';
import { useErrorMessage } from '../../shared/lib';
import styles from './processing.module.css';

export function ReceiptProcessingTab({
  snapshot,
  active,
  live,
  children,
}: {
  snapshot: ProcessingSnapshotResponse;
  active: boolean;
  live: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('admin.queue.receiptProcessing');
  const common = useTranslations('common.actions');
  const describeError = useErrorMessage();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [limit, setLimit] = useState<number | null>(RECEIPT_RETRY_BATCH_SIZE);
  const counts = useQuery({
    queryKey: processingKeys.receipts,
    queryFn: processingApi.receipts,
    enabled: active,
    refetchInterval: active && live ? 5000 : false,
  });
  const retry = useMutation({
    mutationFn: processingApi.retryReceipts,
    onSuccess: (result) => {
      void message.success(t('enqueued', { count: result.enqueued }));
      void client.invalidateQueries({ queryKey: processingKeys.receipts });
      void client.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });
  if (counts.isError)
    return (
      <Alert
        type="error"
        showIcon
        message={describeError(counts.error)}
        action={<Button onClick={() => void counts.refetch()}>{common('retry')}</Button>}
      />
    );
  if (counts.data === undefined) return <Spin />;
  const { counts: totals, extractorConfigured, batchLimit } = counts.data;
  const queue = snapshot.queues.find((row) => row.name === 'receipt-process');
  const paused = queue?.control.paused.effective === true;
  const unavailable = !extractorConfigured || queue?.runtime.registered !== true;
  const batch =
    limit !== null && Number.isInteger(limit) && limit > 0
      ? Math.min(limit, batchLimit, totals.retryable)
      : 0;
  const disabled = counts.isFetching || retry.isPending || paused || unavailable || batch === 0;
  return (
    <div className={styles.cardContent}>
      <Card title={t('title')} extra={<Link href="/receipts">{t('viewReceipts')}</Link>}>
        <div className={styles.receiptMetrics}>
          {(['total', 'done', 'failed', 'queued', 'running', 'skipped'] as const).map((key) => (
            <Statistic
              key={key}
              title={t(`counts.${key}`)}
              value={totals[key]}
              valueStyle={{
                color: key === 'failed' && totals.failed > 0 ? 'var(--ant-color-error)' : 'inherit',
              }}
            />
          ))}
        </div>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          {t('countsHint')}
        </Typography.Paragraph>
      </Card>
      <Card title={t('retryTitle')}>
        <div className={styles.cardContent}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{t('retryHint')}</Typography.Paragraph>
          {paused && <Alert type="warning" showIcon message={t('paused')} />}
          {!extractorConfigured && <Alert type="warning" showIcon message={t('notConfigured')} />}
          {!paused && extractorConfigured && queue?.runtime.registered !== true && (
            <Alert type="warning" showIcon message={t('noWorker')} />
          )}
          {totals.failed > 0 && queue?.runtime.queued === 0 && queue.runtime.active === 0 && (
            <Alert type="info" showIcon message={t('emptyQueue')} />
          )}
          <Typography.Text>{t('eligible', { count: totals.retryable })}</Typography.Text>
          <Space wrap>
            <label htmlFor="receipt-retry-limit">{t('batch')}</label>
            <InputNumber
              id="receipt-retry-limit"
              min={1}
              max={batchLimit}
              precision={0}
              value={limit}
              disabled={retry.isPending}
              onChange={setLimit}
            />
            <Popconfirm
              title={t('confirmTitle', { count: batch })}
              description={t('confirmHint')}
              okText={t('confirm')}
              cancelText={common('cancel')}
              disabled={disabled}
              onConfirm={() => retry.mutate(batch)}
            >
              <Button type="primary" disabled={disabled} loading={retry.isPending}>
                {t('retry', { count: batch })}
              </Button>
            </Popconfirm>
          </Space>
          <Typography.Text type="secondary">
            {t('batchHint', { count: batchLimit })}
          </Typography.Text>
        </div>
      </Card>
      {children}
    </div>
  );
}
