'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Col,
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
  Tooltip,
} from 'antd';
import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
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

// The queue the five document steps run in: the only stage whose block holds a pipeline, because it
// is the only one that has one (docs/05 §5.5).
const DOCUMENT_QUEUE = 'document-process';

// Every state can be asked to run again (docs/11 §11.13). It used to be only the two that look
// broken, which answered the wrong question: a step is re-run because something *about it* changed —
// a container gained a language, a model was configured, a bug was fixed — and by then the documents
// that need redoing are the ones marked DONE. Asking for a QUEUED one is not a mistake either: the
// job is keyed by document, so a second request collapses into the first rather than doubling it.
const RERUNNABLE: readonly StepStatus[] = stepStatusSchema.options;

// /admin/queue (docs/11 §11.13): what the queue is doing, and what failed.
export function AdminQueueScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const [live, setLive] = useState(true);

  const settings = useQuery({ queryKey: queueKeys.settings, queryFn: queueSettingsApi.read });

  // The knobs are held here rather than in a form, because they now live one per stage block instead
  // of in one row of inputs. Filled from the server's answer once it arrives and never fought with
  // afterwards: a number somebody is typing into must not jump under them on a refetch.
  const [draft, setDraft] = useState<{
    concurrency: Record<string, number>;
    unitConcurrency: number;
  } | null>(null);

  useEffect(() => {
    if (settings.data !== undefined && draft === null) {
      setDraft({
        concurrency: { ...settings.data.concurrency },
        unitConcurrency: settings.data.unitConcurrency,
      });
    }
  }, [settings.data, draft]);

  const analysis = useQuery({ queryKey: queueKeys.analysis, queryFn: analysisSettingsApi.read });
  const [language, setLanguage] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Once, like the throughput above: a select nobody has touched follows the server, and one
    // somebody has opened does not close under them on a refetch.
    if (analysis.data !== undefined) {
      setLanguage(
        (current) =>
          current ?? (analysis.data.language === '' ? undefined : analysis.data.language),
      );
    }
  }, [analysis.data]);

  const saveAnalysis = useMutation({
    mutationFn: analysisSettingsApi.save,
    onSuccess: () => {
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: queueKeys.analysis });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // What the stage blocks write into, and what tells the save button there is anything to save.
  const setConcurrency = (queue: string, value: number): void =>
    setDraft((current) =>
      current === null
        ? current
        : { ...current, concurrency: { ...current.concurrency, [queue]: value } },
    );

  const saveThroughput = (): void => {
    if (draft === null) return;
    saveSettings.mutate({
      concurrency: draft.concurrency,
      unitConcurrency: draft.unitConcurrency,
      // Sent whole (docs/07 §7.3): the pause switches live in each block's header, and saving the
      // throughput must not quietly resume what somebody paused.
      paused,
    });
  };

  const changed =
    draft !== null &&
    settings.data !== undefined &&
    (draft.unitConcurrency !== settings.data.unitConcurrency ||
      Object.entries(draft.concurrency).some(
        ([queue, value]) => settings.data?.concurrency[queue] !== value,
      ));

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

      {/* One block per stage of the pipeline, each holding everything about that stage: how deep
          its queue is, how hard it is allowed to work, and — for the stage that has them — the steps
          it runs with their counts and the way to run them again (docs/11 §11.13). Grouped this way
          round because a question is always about one stage: "why is nothing happening in
          document-process" is answered by its depth, its concurrency and its steps together, and
          those used to live in three bands at three ends of the page. */}
      {(overview.data?.queues ?? []).map((queue) => (
        <Card
          key={queue.name}
          loading={overview.isPending}
          title={
            <Space size={8}>
              <Typography.Text strong>{queue.name}</Typography.Text>
              {paused.includes(queue.name) && (
                <Tag color="orange">{t('admin.queue.pause.tag')}</Tag>
              )}
            </Space>
          }
          extra={
            <Space size={8}>
              <Switch
                size="small"
                checked={paused.includes(queue.name)}
                disabled={settings.data === undefined}
                loading={saveSettings.isPending}
                aria-label={t('admin.queue.pause.switch', { queue: queue.name })}
                onChange={(pause) => togglePause(queue.name, pause)}
              />
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space size="large" wrap>
              <Statistic title={t('admin.queue.queued')} value={queue.queued} />
              <Statistic title={t('admin.queue.active')} value={queue.active} />
              <Statistic
                title={t('admin.queue.failedRecent')}
                value={queue.failedRecent}
                // Red only when there is something to be alarmed about.
                {...(queue.failedRecent > 0 ? { valueStyle: { color: token.colorError } } : {})}
              />
            </Space>

            {/* How hard this stage may work, beside how much work it has. Saved and applied at once:
                the workers are re-registered rather than waiting for the container to be bounced
                (docs/11 §11.13). */}
            <Space size="middle" wrap align="end">
              <Statistic
                title={t('admin.queue.settings.concurrency')}
                valueRender={() => (
                  <InputNumber
                    min={1}
                    max={32}
                    style={{ width: 80 }}
                    value={draft?.concurrency[queue.name] ?? 1}
                    disabled={draft === null}
                    onChange={(value) => setConcurrency(queue.name, value ?? 1)}
                  />
                )}
              />
              {queue.name === DOCUMENT_QUEUE && (
                <Statistic
                  title={
                    <Space size={4}>
                      {t('admin.queue.settings.unitConcurrency')}
                      <Tooltip title={t('admin.queue.settings.unitConcurrencyHint')}>
                        <QuestionCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  valueRender={() => (
                    <InputNumber
                      min={1}
                      max={32}
                      style={{ width: 80 }}
                      value={draft?.unitConcurrency ?? 1}
                      disabled={draft === null}
                      onChange={(value) =>
                        setDraft((current) =>
                          current === null ? current : { ...current, unitConcurrency: value ?? 1 },
                        )
                      }
                    />
                  )}
                />
              )}
              <Button
                type="primary"
                loading={saveSettings.isPending}
                disabled={draft === null || !changed}
                onClick={saveThroughput}
              >
                {t('common.actions.save')}
              </Button>
            </Space>

            {queue.name === DOCUMENT_QUEUE && (
              <>
                {/* One language for everything the machine writes, so an archive does not end up
                    with a Russian title over an English description (docs/05 §5.5). It belongs to
                    this stage because this is the stage that writes those words. */}
                <Space size="middle" wrap align="end">
                  <Statistic
                    title={
                      <Space size={4}>
                        {t('admin.queue.settings.analysisLanguage')}
                        <Tooltip title={t('admin.queue.settings.analysisLanguageHint')}>
                          <QuestionCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    valueRender={() => (
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        style={{ minWidth: 220 }}
                        placeholder={t('admin.queue.settings.analysisLanguageAuto')}
                        value={language}
                        onChange={setLanguage}
                        options={LANGUAGE_OPTIONS}
                      />
                    )}
                  />
                  <Button
                    loading={saveAnalysis.isPending}
                    disabled={analysis.data === undefined}
                    onClick={() => saveAnalysis.mutate({ language: language ?? '' })}
                  >
                    {t('common.actions.save')}
                  </Button>
                </Space>

                <PipelineSteps
                  steps={overview.data?.documents.steps ?? []}
                  total={overview.data?.documents.total ?? 0}
                  onRunAgain={(request) => reprocess.mutate(request)}
                  running={reprocess.isPending ? (reprocess.variables ?? null) : null}
                />
              </>
            )}
          </Space>
        </Card>
      ))}

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
// The steps of the pipeline, as the document's own page names them (docs/11 §11.5): one screen
// calling the same step "Тип" and the other "Анализ" is two names for one thing, and the reader has
// to work out that they are the same.
function PipelineSteps({
  steps,
  total,
  onRunAgain,
  running,
}: {
  steps: readonly StepCountersDto[];
  total: number;
  onRunAgain: (request: ReprocessByStepRequest) => void;
  // The request being run right now, if any — so exactly the button that was pressed spins.
  running: ReprocessByStepRequest | null;
}) {
  const t = useTranslations();

  return (
    <Card
      size="small"
      type="inner"
      title={t('admin.queue.pipeline.title')}
      extra={
        <Space size={8}>
          <Typography.Text type="secondary">
            {t('admin.queue.pipeline.total', { count: total })}
          </Typography.Text>
          {/* The whole pipeline of every document. Kept at the top of the block rather than beside
              a step, because it is not a bigger version of a step's button — it is a different
              question (docs/11 §11.13). */}
          <RunAgain
            label={t('admin.queue.actions.runAll')}
            loading={running !== null && running.step === undefined}
            onClick={() => onRunAgain({})}
          />
        </Space>
      }
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {steps.map((step) => (
          <Row key={step.step} align="middle" wrap gutter={[8, 8]}>
            <Col flex="180px">
              <Space size={4}>
                <Typography.Text strong>{t(`viewer.steps.${step.step}`)}</Typography.Text>
                <RunAgain
                  label={t('admin.queue.actions.runStep')}
                  loading={
                    running !== null && running.step === step.step && running.status === undefined
                  }
                  onClick={() => onRunAgain({ step: step.step })}
                />
              </Space>
            </Col>
            <Col flex="auto">
              <StepCounters
                step={step}
                onRunAgain={(status) => onRunAgain({ step: step.step, status })}
                running={
                  running !== null && running.step === step.step ? (running.status ?? null) : null
                }
              />
            </Col>
          </Row>
        ))}
      </Space>
    </Card>
  );
}

// An icon, not a sentence. Repeated once per status per step, a worded button was both the widest
// thing in the row and the thing that pushed the counts off the card (docs/11 §11.15); what it does
// is said on hover and to a screen reader, where a repeated label belongs.
function RunAgain({
  label,
  loading,
  onClick,
}: {
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={label}>
      <Button
        size="small"
        type="text"
        icon={<ReloadOutlined />}
        aria-label={label}
        loading={loading}
        onClick={onClick}
      />
    </Tooltip>
  );
}

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
    <Space size={[16, 8]} wrap>
      {entries.map(({ status, count }) => (
        <Space key={status} size={4}>
          {/* The word, not the enum: the same status is named in the filter above and on the
              document's own page, and a screen that says QUEUED where the others say "в очереди" is
              a third vocabulary to learn (docs/11 §11.13). */}
          <Tag color={statusColor(status)} style={{ marginInlineEnd: 0 }}>
            {t(`documents.filters.stepStatus.${status}`)}
          </Tag>
          {/* A counter nobody can act on is a number on a wall: the point of "12 failed previews"
              is the twelve documents (docs/11 §11.13). Both halves travel, never one — the API
              refuses half the question. */}
          <Link href={`/documents?step=${step.step}&stepStatus=${status}`}>{count}</Link>
          {RERUNNABLE.includes(status) && (
            <RunAgain
              label={t('admin.queue.actions.runAgain')}
              loading={running === status}
              onClick={() => onRunAgain(status)}
            />
          )}
        </Space>
      ))}
    </Space>
  );
}

function statusColor(status: string): string {
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  // Blue is "somebody is coming for this". A step nothing is scheduled for is not that, and gets the
  // brass of a thing waiting to be asked (docs/11 §11.13).
  if (status === 'QUEUED' || status === 'RUNNING') return 'blue';
  if (status === 'PENDING') return 'gold';
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
