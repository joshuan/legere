'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { stepStatusSchema, type StepStatus } from '../../../shared/contracts/enums';
import type {
  FailedJobDto,
  ReprocessByStepRequest,
  StepCountersDto,
} from '../../../shared/contracts/queue';
import { analysisSettingsApi, queueApi, queueKeys, queueSettingsApi } from '../../entities/queue';
import { formatBytes, useErrorMessage } from '../../shared/lib';

// The queue moves on its own, so the view follows it (docs/11 §11.13). Pausing matters: reading a
// long error message while the table reorders underneath is the opposite of useful.
const REFRESH_MS = 5000;

// The statuses a step can be asked to run again from: work that never happened, and work that broke.
// Re-running a DONE step is a different request — one document at a time, from its own page.
const RERUNNABLE: readonly StepStatus[] = ['PENDING', 'FAILED'];

// /admin/queue (docs/11 §11.13): what the queue is doing, and what failed.
export function AdminQueueScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const [live, setLive] = useState(true);

  const [settingsForm] = Form.useForm<Record<string, number>>();
  const settings = useQuery({ queryKey: queueKeys.settings, queryFn: queueSettingsApi.read });

  // The form is filled from the server's answer once it arrives, and never fought with afterwards:
  // a knob somebody is typing into must not jump under them on a refetch.
  useEffect(() => {
    if (settings.data !== undefined) {
      settingsForm.setFieldsValue({
        ...settings.data.concurrency,
        unitConcurrency: settings.data.unitConcurrency,
      });
    }
  }, [settings.data, settingsForm]);

  const [analysisForm] = Form.useForm<{ language?: string | undefined }>();
  const analysis = useQuery({ queryKey: queueKeys.analysis, queryFn: analysisSettingsApi.read });

  useEffect(() => {
    if (analysis.data !== undefined) {
      analysisForm.setFieldsValue({
        language: analysis.data.language === '' ? undefined : analysis.data.language,
      });
    }
  }, [analysis.data, analysisForm]);

  const saveAnalysis = useMutation({
    mutationFn: analysisSettingsApi.save,
    onSuccess: () => {
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: queueKeys.analysis });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const saveSettings = useMutation({
    mutationFn: queueSettingsApi.save,
    onSuccess: () => {
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: queueKeys.settings });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // Paused, a queue keeps taking jobs and runs none of them: the depth grows where an admin can see
  // it and nothing is lost (docs/11 §11.13). It rides inside the settings, which are sent whole.
  const paused = settings.data?.paused ?? [];

  const togglePause = (queue: string, pause: boolean): void => {
    const current = settings.data;
    if (current === undefined) return;
    saveSettings.mutate({
      concurrency: current.concurrency,
      unitConcurrency: current.unitConcurrency,
      paused: pause ? [...current.paused, queue] : current.paused.filter((name) => name !== queue),
    });
  };

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

  // The common repair after a container was down for an hour: every document whose step sits in that
  // status, re-enqueued in one gesture, and it says how many it took (docs/11 §11.13).
  const reprocess = useMutation({
    mutationFn: (body: ReprocessByStepRequest) => queueApi.reprocess(body),
    onSuccess: (result) => {
      void message.success(t('admin.queue.reprocess.enqueued', { count: result.enqueued }), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
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
            <Card
              size="small"
              // A paused queue is labelled as paused everywhere its depth is shown, so a growing
              // queue is never mistaken for a stuck one (docs/11 §11.13).
              title={
                <Space size={4}>
                  {queue.name}
                  {paused.includes(queue.name) && (
                    <Tag color="orange">{t('admin.queue.pause.tag')}</Tag>
                  )}
                </Space>
              }
              extra={
                <Switch
                  size="small"
                  checked={paused.includes(queue.name)}
                  disabled={settings.data === undefined}
                  loading={saveSettings.isPending}
                  aria-label={t('admin.queue.pause.switch', { queue: queue.name })}
                  onChange={(pause) => togglePause(queue.name, pause)}
                />
              }
              loading={overview.isPending}
            >
              <Space size="large">
                <Statistic title={t('admin.queue.queued')} value={queue.queued} />
                <Statistic title={t('admin.queue.active')} value={queue.active} />
                <Statistic
                  title={t('admin.queue.failedRecent')}
                  value={queue.failedRecent}
                  // Red only when there is something to be alarmed about.
                  {...(queue.failedRecent > 0 ? { valueStyle: { color: token.colorError } } : {})}
                />
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      {/* How hard the instance works (docs/11 §11.13). Saved and applied at once: the workers are
          re-registered rather than waiting for the container to be bounced. */}
      <Card title={t('admin.queue.settings.title')} loading={settings.isPending}>
        <Form
          form={settingsForm}
          layout="inline"
          onFinish={(values: Record<string, number>) => {
            const { unitConcurrency, ...concurrency } = values;
            saveSettings.mutate({
              concurrency,
              unitConcurrency: unitConcurrency ?? 1,
              // Sent whole (docs/07 §7.3): the pause switches live on the cards above, and saving
              // the throughput must not quietly resume what somebody paused.
              paused,
            });
          }}
        >
          {Object.keys(settings.data?.concurrency ?? {}).map((queue) => (
            <Form.Item key={queue} name={queue} label={queue}>
              <InputNumber min={1} max={32} style={{ width: 80 }} />
            </Form.Item>
          ))}
          <Form.Item
            name="unitConcurrency"
            label={t('admin.queue.settings.unitConcurrency')}
            tooltip={t('admin.queue.settings.unitConcurrencyHint')}
          >
            <InputNumber min={1} max={32} style={{ width: 80 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saveSettings.isPending}>
              {t('common.actions.save')}
            </Button>
          </Form.Item>
        </Form>

        {/* One language for everything the machine writes, so an archive does not end up with a
            Russian title over an English description (docs/05 §5.5). Empty keeps what it did
            before: each field in the language of its own document. */}
        <Form
          form={analysisForm}
          layout="inline"
          style={{ marginTop: 16 }}
          onFinish={(values: { language?: string | undefined }) =>
            saveAnalysis.mutate({ language: values.language ?? '' })
          }
        >
          <Form.Item
            name="language"
            label={t('admin.queue.settings.analysisLanguage')}
            tooltip={t('admin.queue.settings.analysisLanguageHint')}
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 220 }}
              placeholder={t('admin.queue.settings.analysisLanguageAuto')}
              options={LANGUAGE_OPTIONS}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saveAnalysis.isPending}>
              {t('common.actions.save')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

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
                <StepCounters
                  step={step}
                  onRunAgain={(status) => reprocess.mutate({ step: step.step, status })}
                  running={
                    reprocess.isPending && reprocess.variables?.step === step.step
                      ? reprocess.variables.status
                      : null
                  }
                />
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
// spend a row saying zero. In the statuses' own order rather than the server's, so the five cards
// read alike.
function StepCounters({
  step,
  onRunAgain,
  running,
}: {
  step: StepCountersDto;
  onRunAgain: (status: StepStatus) => void;
  // The status of this step being re-enqueued right now, if any.
  running: StepStatus | null;
}) {
  const t = useTranslations();

  const entries = stepStatusSchema.options
    // A status the server did not mention holds nothing, which is the same thing as a zero here.
    .map((status) => ({ status, count: step.counts[status] ?? 0 }))
    .filter((entry) => entry.count > 0);
  if (entries.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;

  return (
    <Space direction="vertical" size={0}>
      {entries.map(({ status, count }) => (
        <Space key={status} size={4}>
          <Tag color={statusColor(status)}>{status}</Tag>
          {/* A counter nobody can act on is a number on a wall: the point of "12 failed previews"
              is the twelve documents (docs/11 §11.13). Both halves travel, never one — the API
              refuses half the question. */}
          <Link href={`/documents?step=${step.step}&stepStatus=${status}`}>{count}</Link>
          {RERUNNABLE.includes(status) && (
            <Button
              size="small"
              type="link"
              loading={running === status}
              onClick={() => onRunAgain(status)}
            >
              {t('admin.queue.actions.runAgain')}
            </Button>
          )}
        </Space>
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

// Every language Intl can name, in the reader's own language — the same list the viewer offers for a
// document's languages (docs/11 §11.5). Built rather than shipped: a table of languages goes out of
// date and one asked of Intl cannot.
const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = (() => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const options: Array<{ value: string; label: string }> = [];
  for (const first of letters) {
    for (const second of letters) {
      const code = `${first}${second}`;
      let name = code;
      try {
        name = new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) ?? code;
      } catch {
        name = code;
      }
      if (name !== code) options.push({ value: code, label: `${name} (${code})` });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
})();
