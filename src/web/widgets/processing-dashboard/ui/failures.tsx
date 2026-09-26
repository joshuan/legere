'use client';

import { Button, Card, Tag, Typography } from 'antd';
import { ResponsiveTable as Table } from '../../../shared/ui';
import { useTranslations } from 'next-intl';
import { type FailedJobDto } from '../../../../shared/contracts/queue';

export function FailuresTable({
  jobs,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  retrying,
  onRetry,
}: {
  jobs: readonly FailedJobDto[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  retrying: string | null;
  onRetry: (jobId: string) => void;
}) {
  const t = useTranslations();
  return (
    <Card
      title={t('admin.queue.failures.title')}
      extra={
        hasMore ? (
          <Button size="small" loading={loadingMore} onClick={onLoadMore}>
            {t('admin.queue.failures.more')}
          </Button>
        ) : null
      }
    >
      <Table<FailedJobDto>
        rowKey="jobId"
        loading={loading}
        dataSource={[...jobs]}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('admin.queue.failures.empty') }}
        expandable={{
          expandedRowRender: (job) => (
            <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {job.error}
            </Typography.Paragraph>
          ),
        }}
        columns={[
          {
            title: t('admin.queue.failures.time'),
            key: 'time',
            render: (_, job) => new Date(job.failedAt).toLocaleString(),
          },
          {
            title: t('admin.queue.failures.queue'),
            key: 'queue',
            render: (_, job) => <Tag>{job.queue}</Tag>,
          },
          {
            title: t('admin.queue.failures.payload'),
            key: 'payload',
            render: (_, job) => (
              <Typography.Text code>{describePayload(job.payload)}</Typography.Text>
            ),
          },
          {
            title: t('admin.queue.failures.retries'),
            key: 'retries',
            render: (_, job) => job.retryCount,
          },
          {
            title: t('admin.queue.failures.actions'),
            key: 'actions',
            render: (_, job) => (
              <Button
                size="small"
                loading={retrying === job.jobId}
                onClick={() => onRetry(job.jobId)}
              >
                {t('admin.queue.actions.retry')}
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}

function describePayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '—';
  const entries = Object.entries(payload)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length === 0 ? '—' : entries.join(' ');
}
