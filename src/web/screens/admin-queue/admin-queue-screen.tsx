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
  Spin,
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
import type { GlobalToken } from 'antd';
import {
  SERVICE_COOLDOWN_MAX_SECONDS,
  SERVICE_NAMES,
  type FailedJobDto,
  type ReprocessByStepRequest,
  type ServiceGateDto,
  type ServiceHealthDto,
  type ServiceHealthStatus,
  type ServiceName,
  type StepCountersDto,
} from '../../../shared/contracts/queue';
import {
  analysisSettingsApi,
  queueApi,
  queueKeys,
  queueSettingsApi,
  servicesHealthApi,
} from '../../entities/queue';
import { formatBytes, useErrorMessage } from '../../shared/lib';

// The queue moves on its own, so the view follows it (docs/11 §11.13). Pausing matters: reading a
// long error message while the table reorders underneath is the opposite of useful.
const REFRESH_MS = 5000;

// The probes go on a slower clock than the counters, and deliberately: a counter is a read of this
// instance's own database, while a probe leaves it and knocks on five doors (docs/11 §11.13).
const SERVICES_REFRESH_MS = 60_000;

// The queue the five document steps run in: the only stage whose block holds a pipeline, because it
// is the only one that has one (docs/05 §5.5).
const DOCUMENT_QUEUE = 'document-process';

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
    services: Record<string, ServiceGateDto>;
  } | null>(null);

  useEffect(() => {
    if (settings.data !== undefined && draft === null) {
      setDraft({
        concurrency: { ...settings.data.concurrency },
        unitConcurrency: settings.data.unitConcurrency,
        services: { ...settings.data.services },
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

  // One gate of one service (docs/05 §5.4b), edited knob by knob into the same draft the stage
  // blocks write into — the payload is sent whole either way.
  const setGate = (service: string, gate: Partial<ServiceGateDto>): void =>
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            services: {
              ...current.services,
              [service]: {
                ...(current.services[service] ?? { concurrency: 0, cooldownSeconds: 0 }),
                ...gate,
              },
            },
          },
    );

  const saveDraft = (): void => {
    if (draft === null) return;
    saveSettings.mutate({
      concurrency: draft.concurrency,
      unitConcurrency: draft.unitConcurrency,
      // Sent whole (docs/07 §7.3): the pause switches live in each block's header, and saving the
      // throughput must not quietly resume what somebody paused — a queue or a step (docs/05 §5.4d).
      paused,
      pausedSteps,
      services: draft.services,
    });
  };

  const changed =
    draft !== null &&
    settings.data !== undefined &&
    (draft.unitConcurrency !== settings.data.unitConcurrency ||
      Object.entries(draft.concurrency).some(
        ([queue, value]) => settings.data?.concurrency[queue] !== value,
      ));

  // The services block has a save of its own, and it lights up for its own reason: a gate that
  // differs from what the server holds, not a concurrency somebody changed two blocks above.
  const gatesChanged =
    draft !== null &&
    settings.data !== undefined &&
    SERVICE_NAMES.some((service) => {
      const held = settings.data?.services[service];
      const edited = draft.services[service];
      return (
        held?.concurrency !== edited?.concurrency ||
        held?.cooldownSeconds !== edited?.cooldownSeconds
      );
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
  // The same for a single step of the pipeline: held at PENDING, nothing written against it, and
  // resuming sets the documents that piled up going again (docs/05 §5.4d).
  const pausedSteps = settings.data?.pausedSteps ?? [];

  const togglePause = (queue: string, pause: boolean): void => {
    const current = settings.data;
    if (current === undefined) return;
    saveSettings.mutate({
      concurrency: current.concurrency,
      unitConcurrency: current.unitConcurrency,
      paused: pause ? [...current.paused, queue] : current.paused.filter((name) => name !== queue),
      pausedSteps: current.pausedSteps,
      services: current.services,
    });
  };

  const overview = useQuery({
    queryKey: queueKeys.overview,
    queryFn: queueApi.overview,
    refetchInterval: live ? REFRESH_MS : false,
  });

  // Where the external services are and whether they answer (docs/05 §5.4c). A query of its own, so
  // the gates beside it draw and save while a probe is still waiting on a container that will never
  // answer — and on its own slower clock, because this one leaves the instance.
  const services = useQuery({
    queryKey: queueKeys.services,
    queryFn: servicesHealthApi.read,
    refetchInterval: live ? SERVICES_REFRESH_MS : false,
  });

  const healthOf = (service: ServiceName): ServiceHealthDto | undefined =>
    services.data?.services.find((row) => row.service === service);

  // One probe stamps every row with one time (docs/05 §5.4c), so the first row speaks for the block.
  const checkedAt = services.data?.services[0]?.checkedAt;

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
          // What the stage is called in this product, over what it is called in the queue. The
          // technical name is the one that appears in the failed-jobs table below and in the
          // container's own logs, so it stays — but it is not what somebody comes to this page to
          // read (docs/11 §11.13).
          title={
            <Space size={8} align="baseline">
              <Typography.Text strong>{t(`admin.queue.names.${queue.name}`)}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                {queue.name}
              </Typography.Text>
              {paused.includes(queue.name) && (
                <Tag color="orange">{t('admin.queue.pause.tag')}</Tag>
              )}
            </Space>
          }
          // 🔒 A switch with nothing beside it is a switch nobody can read: this one used to sit
          // bare in the corner, and "what does this checkbox do" is a question the screen should
          // never make somebody ask (docs/11 §11.14).
          extra={
            <Space size={8}>
              <Typography.Text type="secondary">{t('admin.queue.pause.title')}</Typography.Text>
              <Tooltip title={t('admin.queue.pause.hint')}>
                <QuestionCircleOutlined style={{ color: token.colorTextTertiary }} />
              </Tooltip>
              <Switch
                size="small"
                // Reads as what it is: on means the stage runs. Inverted from the value it holds,
                // because "paused" as a switch you turn *on* to stop things is a double negative.
                checked={!paused.includes(queue.name)}
                disabled={settings.data === undefined}
                loading={saveSettings.isPending}
                aria-label={t('admin.queue.pause.switch', { queue: queue.name })}
                onChange={(running) => togglePause(queue.name, !running)}
              />
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* What this stage actually does, in one line. The names above are short by design; this
                is where somebody who has never read docs/05 finds out what they mean. */}
            <Typography.Text type="secondary">
              {t(`admin.queue.hints.${queue.name}`)}
            </Typography.Text>

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
                onClick={saveDraft}
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

      {/* One block of its own, below the stages, because a service is not a stage and putting its
          gate inside one would hide it from the other: Stirling renders pages for document-process
          and converts an upload for file-ingest, and there is one container being asked
          (docs/11 §11.13, docs/05 §5.4b). */}
      <Card
        title={t('admin.queue.services.title')}
        loading={settings.isPending}
        // 🔒 The check is offered here and never waited for: the probes have their own query, and a
        // dead container times out beside the gates rather than instead of them (docs/11 §11.13).
        extra={
          <Space size={8}>
            {checkedAt !== undefined && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('admin.queue.services.checkedAt', {
                  time: new Date(checkedAt).toLocaleTimeString(),
                })}
              </Typography.Text>
            )}
            <Button
              size="small"
              // Decorative: the button says what it does in words, and an icon that also announces
              // itself makes a screen reader read "reload Check" (docs/11 §11.14).
              icon={<ReloadOutlined aria-hidden />}
              loading={services.isFetching}
              onClick={() => void queryClient.invalidateQueries({ queryKey: queueKeys.services })}
            >
              {t('admin.queue.services.check')}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('admin.queue.services.hint')}</Typography.Text>

          <Table<ServiceName>
            size="small"
            rowKey={(service) => service}
            pagination={false}
            dataSource={[...SERVICE_NAMES]}
            columns={[
              {
                title: t('admin.queue.services.service'),
                key: 'service',
                // Named twice, the way the stages are: what it is, over what it is called in the
                // settings, with a line under it saying which work it serves.
                render: (_: unknown, service: ServiceName) => (
                  <Space direction="vertical" size={0}>
                    <Space size={8} align="baseline">
                      <Typography.Text strong>
                        {t(`admin.queue.services.names.${service}`)}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                        {service}
                      </Typography.Text>
                    </Space>
                    <Typography.Text type="secondary">
                      {t(`admin.queue.services.hints.${service}`)}
                    </Typography.Text>
                    {/* Where this instance actually calls it (docs/05 §5.4c) — read to be
                        recognised rather than transcribed, so it is cut off rather than wrapped,
                        with the whole of it on hover. An instance running without the service says
                        so in words instead of leaving a gap that reads as a bug. */}
                    <ServiceAddress health={healthOf(service)} />
                  </Space>
                ),
              },
              {
                title: (
                  <Space size={4}>
                    {t('admin.queue.services.state')}
                    <Tooltip title={t('admin.queue.services.stateHint')}>
                      <QuestionCircleOutlined />
                    </Tooltip>
                  </Space>
                ),
                key: 'health',
                render: (_: unknown, service: ServiceName) => (
                  <ServiceState health={healthOf(service)} pending={services.isPending} />
                ),
              },
              {
                title: (
                  <Space size={4}>
                    {t('admin.queue.services.concurrency')}
                    <Tooltip title={t('admin.queue.services.concurrencyHint')}>
                      <QuestionCircleOutlined />
                    </Tooltip>
                  </Space>
                ),
                key: 'concurrency',
                render: (_: unknown, service: ServiceName) => (
                  <InputNumber
                    // 🔒 0 is a value here, not an empty box: it reads as "as many as the queues
                    // ask for", which is what an instance that has never been gated is running on.
                    min={0}
                    max={32}
                    style={{ width: 80 }}
                    aria-label={t('admin.queue.services.concurrencyFor', {
                      service: t(`admin.queue.services.names.${service}`),
                    })}
                    value={draft?.services[service]?.concurrency ?? 0}
                    disabled={draft === null}
                    onChange={(value) => setGate(service, { concurrency: value ?? 0 })}
                  />
                ),
              },
              {
                title: (
                  <Space size={4}>
                    {t('admin.queue.services.cooldown')}
                    <Tooltip title={t('admin.queue.services.cooldownHint')}>
                      <QuestionCircleOutlined />
                    </Tooltip>
                  </Space>
                ),
                key: 'cooldown',
                render: (_: unknown, service: ServiceName) => (
                  <InputNumber
                    min={0}
                    max={SERVICE_COOLDOWN_MAX_SECONDS}
                    style={{ width: 80 }}
                    aria-label={t('admin.queue.services.cooldownFor', {
                      service: t(`admin.queue.services.names.${service}`),
                    })}
                    value={draft?.services[service]?.cooldownSeconds ?? 0}
                    disabled={draft === null}
                    onChange={(value) => setGate(service, { cooldownSeconds: value ?? 0 })}
                  />
                ),
              },
            ]}
          />

          {/* Offered only once something differs from what the server holds, exactly as the
              throughput settings above are, and in force without a restart (docs/11 §11.13). */}
          <Button
            type="primary"
            loading={saveSettings.isPending}
            disabled={draft === null || !gatesChanged}
            onClick={saveDraft}
          >
            {t('common.actions.save')}
          </Button>
        </Space>
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
  const { token } = theme.useToken();

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
      {/* A table, not a row of chips per step: with one column per status the same word lands in
          the same place on every line, and "which steps are still queued" is answered by reading
          down instead of hunting across. Empty cells are the price and they are worth it — a gap in
          a column says "none of these" at a glance, which a missing chip cannot (docs/11 §11.13). */}
      <Table<StepCountersDto>
        size="small"
        rowKey="step"
        pagination={false}
        dataSource={[...steps]}
        columns={[
          {
            title: t('admin.queue.pipeline.step'),
            dataIndex: 'step',
            render: (_: unknown, row: StepCountersDto) => (
              <Space size={4}>
                <Typography.Text strong>{t(`viewer.steps.${row.step}`)}</Typography.Text>
                <RunAgain
                  label={t('admin.queue.actions.runStep')}
                  loading={
                    running !== null && running.step === row.step && running.status === undefined
                  }
                  onClick={() => onRunAgain({ step: row.step })}
                />
              </Space>
            ),
          },
          ...stepStatusSchema.options.map((status) => ({
            title: (
              <Typography.Text style={{ color: statusColor(status, token) }}>
                {t(`documents.filters.stepStatus.${status}`)}
              </Typography.Text>
            ),
            key: status,
            align: 'center' as const,
            render: (_: unknown, row: StepCountersDto) => {
              const count = row.counts[status] ?? 0;
              // A zero is not drawn: an archive where nothing failed should not read as a wall of
              // noughts, and the empty cell under a column says the same thing more quietly.
              if (count === 0) return null;
              return (
                <Space size={4}>
                  {/* A counter nobody can act on is a number on a wall: the point of "12 failed
                      previews" is the twelve documents. Both halves of the question travel — the
                      API refuses one without the other. */}
                  <Link href={`/documents?step=${row.step}&stepStatus=${status}`}>{count}</Link>
                  <RunAgain
                    label={t('admin.queue.actions.runAgain')}
                    loading={
                      running !== null && running.step === row.step && running.status === status
                    }
                    onClick={() => onRunAgain({ step: row.step, status })}
                  />
                </Space>
              );
            },
          })),
        ]}
      />
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

// The address a service is called at, under the line saying what it does (docs/05 §5.4c). Nothing
// at all while the first probe is still out: an address that arrives a second later is better than a
// placeholder somebody has to un-read.
function ServiceAddress({ health }: { health: ServiceHealthDto | undefined }) {
  const t = useTranslations();
  if (health === undefined) return null;
  if (health.url === '') {
    return (
      <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
        {t('admin.queue.services.addressUnset')}
      </Typography.Text>
    );
  }
  return (
    <Typography.Text
      type="secondary"
      code
      style={{ fontSize: 12, maxWidth: 460 }}
      ellipsis={{ tooltip: health.url }}
    >
      {health.url}
    </Typography.Text>
  );
}

// What each state costs, in colour. 🔒 `NOT_CONFIGURED` is grey and never red: an instance running
// without Docling or without an analyst is a supported way to run, and a screen that paints it as
// broken teaches an operator to ignore the column (docs/11 §11.13).
const HEALTH_COLORS: Record<ServiceHealthStatus, string> = {
  UP: 'success',
  // Something is there and something is wrong with it — a person is needed, but not the same person
  // in the same hurry as for a service that is not answering at all.
  UNAUTHORIZED: 'warning',
  ANSWERED: 'warning',
  DOWN: 'error',
  NOT_CONFIGURED: 'default',
};

function ServiceState({
  health,
  pending,
}: {
  health: ServiceHealthDto | undefined;
  pending: boolean;
}) {
  const t = useTranslations();
  if (health === undefined) {
    return pending ? <Spin size="small" /> : <Typography.Text type="secondary">—</Typography.Text>;
  }
  return (
    <Tooltip title={<ServiceStateDetail health={health} />}>
      <Tag color={HEALTH_COLORS[health.status]} style={{ marginInlineEnd: 0 }}>
        {t(`admin.queue.services.health.${health.status}`)}
      </Tag>
    </Tooltip>
  );
}

// What a tag cannot hold and a person needs the moment it is not green: the code, how long it took,
// the transport's own reason, and when this was taken — a held answer reading as held (docs/11
// §11.13, §11.14).
function ServiceStateDetail({ health }: { health: ServiceHealthDto }) {
  const t = useTranslations();
  return (
    <Space direction="vertical" size={0}>
      <span>{t(`admin.queue.services.healthHints.${health.status}`)}</span>
      {health.httpStatus !== null && (
        <span>{t('admin.queue.services.httpCode', { code: health.httpStatus })}</span>
      )}
      {health.latencyMs !== null && (
        <span>{t('admin.queue.services.latency', { ms: health.latencyMs })}</span>
      )}
      {health.detail !== null && <span>{health.detail}</span>}
      <span>
        {t('admin.queue.services.checkedAt', {
          time: new Date(health.checkedAt).toLocaleTimeString(),
        })}
      </span>
    </Space>
  );
}

// The colour of a status, as the theme names it rather than as antd's tag palette does: this now
// paints a column heading, and a heading has to sit in the same ink as the rest of the table
// (docs/11 §11.15). Red is the one that has to survive being scanned past.
function statusColor(status: StepStatus, token: GlobalToken): string {
  if (status === 'DONE') return token.colorSuccess;
  if (status === 'FAILED') return token.colorError;
  // Blue is "somebody is coming for this". A step nothing is scheduled for is not that, and takes
  // the brass of a thing waiting to be asked.
  if (status === 'QUEUED' || status === 'RUNNING') return token.colorInfo;
  if (status === 'PENDING') return token.colorWarning;
  return token.colorTextTertiary;
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
