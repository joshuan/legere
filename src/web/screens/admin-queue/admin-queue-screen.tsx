'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type { FailedJobDto, StepCountersDto } from '../../../shared/contracts/queue';
import { queueApi, queueKeys } from '../../entities/queue';
import { formatBytes, useErrorMessage } from '../../shared/lib';

// The queue moves on its own, so the view follows it (docs/11 §11.13). Pausing matters: reading a
// long error message while the table reorders underneath is the opposite of useful.
const REFRESH_MS = 5000;

// /admin/queue (docs/11 §11.13): what the queue is doing, and what failed.
export function AdminQueueScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const [live, setLive] = useState(true);

  const overview = useQuery({
    queryKey: queueKeys.overview,
    queryFn: queueApi.overview,
    refetchInterval: live ? REFRESH_MS : false,
  });

  const failures = useQuery({
    queryKey: queueKeys.failures,
    queryFn: queueApi.failures,
    refetchInterval: live ? REFRESH_MS : false,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queueKeys.overview });
    void queryClient.invalidateQueries({ queryKey: queueKeys.failures });
  }, [queryClient]);

  const retry = useMutation({
    mutationFn: (jobId: string) => queueApi.retry(jobId),
    onSuccess: () => {
      void message.success(t('admin.queue.retried'), 2);
      refresh();
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  // Refreshed hourly by `maintenance`, so it is null on a fresh instance (docs/09 §9.5).
  const storage = overview.data?.storage ?? null;

  const failureColumns = [
    {
      title: t('admin.queue.failures.time'),
      key: 'failedAt',
      render: (_: unknown, job: FailedJobDto) => new Date(job.failedAt).toLocaleString(),
    },
    {
      title: t('admin.queue.failures.queue'),
      key: 'queue',
      render: (_: unknown, job: FailedJobDto) => <Tag>{job.queue}</Tag>,
    },
    {
      title: t('admin.queue.failures.payload'),
      key: 'payload',
      render: (_: unknown, job: FailedJobDto) => (
        <Typography.Text code>{describePayload(job.payload)}</Typography.Text>
      ),
    },
    {
      title: t('admin.queue.failures.retries'),
      key: 'retryCount',
      render: (_: unknown, job: FailedJobDto) => job.retryCount,
    },
    {
      title: t('admin.queue.failures.actions'),
      key: 'actions',
      render: (_: unknown, job: FailedJobDto) => (
        <Button
          size="small"
          onClick={() => retry.mutate(job.jobId)}
          loading={retry.isPending && retry.variables === job.jobId}
        >
          {t('admin.queue.actions.retry')}
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row align="middle" justify="space-between">
        <Col>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('admin.queue.title')}
          </Typography.Title>
        </Col>
        <Col>
          <Space>
            <Typography.Text type="secondary">{t('admin.queue.autoRefresh')}</Typography.Text>
            <Switch
              checked={live}
              onChange={setLive}
              aria-label={t('admin.queue.autoRefresh')}
              checkedChildren={t('admin.queue.live')}
              unCheckedChildren={t('admin.queue.paused')}
            />
          </Space>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {(overview.data?.queues ?? []).map((queue) => (
          <Col key={queue.name} xs={24} sm={12} lg={6}>
            <Card size="small" title={queue.name} loading={overview.isPending}>
              <Space size="large">
                <Statistic title={t('admin.queue.queued')} value={queue.queued} />
                <Statistic title={t('admin.queue.active')} value={queue.active} />
                <Statistic
                  title={t('admin.queue.failedRecent')}
                  value={queue.failedRecent}
                  // Red only when there is something to be alarmed about.
                  {...(queue.failedRecent > 0 ? { valueStyle: { color: '#cf1322' } } : {})}
                />
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        title={t('admin.queue.pipeline.title')}
        loading={overview.isPending}
        extra={
          <Typography.Text type="secondary">
            {t('admin.queue.pipeline.total', { count: overview.data?.documents.total ?? 0 })}
          </Typography.Text>
        }
      >
        <Row gutter={[16, 16]}>
          {(overview.data?.documents.steps ?? []).map((step) => (
            <Col key={step.step} xs={24} sm={12} lg={8} xl={4}>
              <Card size="small" type="inner" title={t(`admin.queue.steps.${step.step}`)}>
                {stepSummary(step)}
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <Card title={t('admin.queue.storage.title')} loading={overview.isPending}>
        {storage === null ? (
          // Honest until maintenance has run once: a zero here would read as an empty bucket.
          <Typography.Text type="secondary">{t('admin.queue.storage.pending')}</Typography.Text>
        ) : (
          <Space size="large" wrap>
            <Statistic title={t('admin.queue.storage.objects')} value={storage.objects} />
            {/* Through the formatter, not as a value: Statistic splits a value on its decimal
                separator to style the fraction, which would break "1.8 GB" into two spans. */}
            <Statistic
              title={t('admin.queue.storage.size')}
              value={storage.bytes}
              formatter={() => formatBytes(storage.bytes)}
            />
            <Typography.Text type="secondary">
              {t('admin.queue.storage.measuredAt', {
                time: new Date(storage.measuredAt).toLocaleString(),
              })}
            </Typography.Text>
          </Space>
        )}
      </Card>

      <Card title={t('admin.queue.failures.title')}>
        <Table
          rowKey="jobId"
          loading={failures.isPending}
          dataSource={failures.data?.items ?? []}
          columns={failureColumns}
          pagination={false}
          locale={{ emptyText: t('admin.queue.failures.empty') }}
          // The error is the reason anyone opens this page, and it can be a wall of text — it lives
          // in an expandable row rather than a truncated cell (docs/11 §11.13).
          expandable={{
            expandedRowRender: (job: FailedJobDto) => (
              <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {job.error}
              </Typography.Paragraph>
            ),
            rowExpandable: () => true,
          }}
        />
      </Card>
    </Space>
  );
}

// One line per status that actually has documents in it; a step with nothing in a status should not
// spend a row saying zero.
function stepSummary(step: StepCountersDto): React.ReactNode {
  const entries = Object.entries(step.counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;

  return (
    <Space direction="vertical" size={0}>
      {entries.map(([status, count]) => (
        <Typography.Text key={status}>
          <Tag color={statusColor(status)}>{status}</Tag>
          {count}
        </Typography.Text>
      ))}
    </Space>
  );
}

function statusColor(status: string): string {
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'PENDING') return 'blue';
  return 'default';
}

// The payload is whatever the job carried; show the ids it holds rather than raw JSON.
function describePayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '—';
  const entries = Object.entries(payload)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length === 0 ? '—' : entries.join(' ');
}
