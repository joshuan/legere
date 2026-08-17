'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
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
  Tabs,
  Tag,
  Typography,
  theme,
  Tooltip,
} from 'antd';
import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { stepStatusSchema, type StepStatus } from '../../../shared/contracts/enums';
import type { DocumentStep } from '../../../shared/contracts/documents';
import type { GlobalToken } from 'antd';
import {
  SERVICE_COOLDOWN_MAX_SECONDS,
  SERVICE_NAMES,
  type FailedJobDto,
  type QueueDepthDto,
  type ReprocessByStepRequest,
  type ServiceGateDto,
  type ServiceGateSnapshotDto,
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
import { adminQueueHref, isAdminQueueTab, type AdminQueueTab } from './admin-queue-tab';

// The queue moves on its own, so the view follows it (docs/11 §11.13). Pausing matters: reading a
// long error message while the table reorders underneath is the opposite of useful.
const REFRESH_MS = 5000;

// The probes go on a slower clock than the counters, and deliberately: a counter is a read of this
// instance's own database, while a probe leaves it and knocks on five doors (docs/11 §11.13).
const SERVICES_REFRESH_MS = 60_000;

// /admin/queue/:tab (docs/11 §11.13): four tabs, one question each — is anything moving, where are
// the documents stuck, is the thing we call answering, what broke.
export function AdminQueueScreen({ tab = 'overview' }: { tab?: AdminQueueTab }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const router = useRouter();

  // The address is the source of truth, but the tab switches on the click rather than after the
  // navigation: a tab that waits for the router to come back feels broken (docs/10 §10.2).
  const [active, setActive] = useState<AdminQueueTab>(tab);
  useEffect(() => setActive(tab), [tab]);

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

  // One save per tab, and each lights up for its own reason: a stage's concurrency on Overview, the
  // units of one run on Pipeline, a gate on Services. The payload is sent whole either way
  // (docs/07 §7.3), so what differs is only which button offers to send it.
  const concurrencyChanged =
    draft !== null &&
    settings.data !== undefined &&
    Object.entries(draft.concurrency).some(
      ([queue, value]) => settings.data?.concurrency[queue] !== value,
    );

  const unitsChanged =
    draft !== null &&
    settings.data !== undefined &&
    draft.unitConcurrency !== settings.data.unitConcurrency;

  // The services tab has a save of its own, and it lights up for its own reason: a gate that
  // differs from what the server holds, not a concurrency somebody changed on another tab.
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

  // The same switch one level down, on the row where the step is already named (docs/11 §11.13).
  // Releasing one sets the documents it was holding going again, which the server does on the save.
  const togglePauseStep = (step: DocumentStep, pause: boolean): void => {
    const current = settings.data;
    if (current === undefined) return;
    saveSettings.mutate({
      concurrency: current.concurrency,
      unitConcurrency: current.unitConcurrency,
      paused: current.paused,
      pausedSteps: pause
        ? [...current.pausedSteps, step]
        : current.pausedSteps.filter((name) => name !== step),
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

  // What the gate in front of that service is doing this instant (docs/05 §5.4b). It arrives with the
  // counters rather than with the probes: this one is a read of our own semaphore.
  const gateOf = (service: ServiceName): ServiceGateSnapshotDto | undefined =>
    overview.data?.gates.find((row) => row.service === service);

  // One probe stamps every row with one time (docs/05 §5.4c), so the first row speaks for the block.
  const checkedAt = services.data?.services[0]?.checkedAt;

  // Only while its tab is open: the count that decides whether anybody needs to look is on the
  // overview already, and a list nobody is reading is a page of pg-boss rows fetched every 5 seconds.
  const failures = useQuery({
    queryKey: queueKeys.failures,
    queryFn: queueApi.failures,
    enabled: active === 'failures',
    refetchInterval: live && active === 'failures' ? REFRESH_MS : false,
  });

  // How many jobs failed in the last day, over every stage: the number on the Failures tab's own
  // label, and the one the summary line reports (docs/11 §11.13).
  const failedRecent = (overview.data?.queues ?? []).reduce(
    (total, queue) => total + queue.failedRecent,
    0,
  );

  // A service that is configured and did not answer. `NOT_CONFIGURED` is not one of them: an instance
  // running without Docling or without an analyst is a supported way to run (docs/05 §5.4c).
  const unhealthy = (services.data?.services ?? []).filter(
    (health) => health.status !== 'UP' && health.status !== 'NOT_CONFIGURED',
  );

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

  // What is not in order, in one sentence, over the rows that answer it (docs/11 §11.13). Nothing to
  // report is said in as many words: an empty strip and a page that has not loaded look alike.
  const summary = (
    <Summary
      paused={paused}
      pausedSteps={pausedSteps}
      failedRecent={failedRecent}
      unhealthy={unhealthy}
      loading={overview.isPending || settings.isPending}
    />
  );

  // One row per stage instead of a card per stage: the depth, the knob that decides how fast it
  // falls, and the switch that says whether the stage runs at all, on one line each so five stages
  // read as five lines rather than as five screens (docs/11 §11.13).
  const stages = (
    <Card
      title={t('admin.queue.stages.title')}
      loading={overview.isPending}
      extra={
        <Button
          type="primary"
          loading={saveSettings.isPending}
          disabled={draft === null || !concurrencyChanged}
          onClick={saveDraft}
        >
          {t('common.actions.save')}
        </Button>
      }
    >
      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={[...(overview.data?.queues ?? [])]}
        columns={[
          {
            title: t('admin.queue.stages.stage'),
            key: 'stage',
            render: (_: unknown, queue: QueueDepthDto) => (
              <Space direction="vertical" size={0}>
                <Space size={8} align="baseline">
                  <Typography.Text strong>{t(`admin.queue.names.${queue.name}`)}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                    {queue.name}
                  </Typography.Text>
                  {paused.includes(queue.name) && (
                    <Tag color="orange">{t('admin.queue.pause.tag')}</Tag>
                  )}
                </Space>
                {/* What this stage actually does. The name above is short by design; this is where
                    somebody who has never read docs/05 finds out what it means. */}
                <Typography.Text type="secondary">
                  {t(`admin.queue.hints.${queue.name}`)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('admin.queue.queued'),
            key: 'queued',
            align: 'right' as const,
            render: (_: unknown, queue: QueueDepthDto) => queue.queued,
          },
          {
            title: t('admin.queue.active'),
            key: 'active',
            align: 'right' as const,
            render: (_: unknown, queue: QueueDepthDto) => queue.active,
          },
          {
            title: t('admin.queue.failedRecent'),
            key: 'failedRecent',
            align: 'right' as const,
            // A zero is not drawn, and a failure is drawn in the ink that says so.
            render: (_: unknown, queue: QueueDepthDto) =>
              queue.failedRecent === 0 ? null : (
                <Typography.Text style={{ color: token.colorError }}>
                  {queue.failedRecent}
                </Typography.Text>
              ),
          },
          {
            title: (
              <Space size={4}>
                {t('admin.queue.settings.concurrency')}
                <Tooltip title={t('admin.queue.settings.concurrencyHint')}>
                  <QuestionCircleOutlined />
                </Tooltip>
              </Space>
            ),
            key: 'concurrency',
            render: (_: unknown, queue: QueueDepthDto) => (
              <InputNumber
                min={1}
                max={32}
                style={{ width: 80 }}
                aria-label={t('admin.queue.settings.concurrencyFor', {
                  stage: t(`admin.queue.names.${queue.name}`),
                })}
                value={draft?.concurrency[queue.name] ?? 1}
                disabled={draft === null}
                onChange={(value) => setConcurrency(queue.name, value ?? 1)}
              />
            ),
          },
          {
            title: (
              <Space size={4}>
                {t('admin.queue.pause.title')}
                <Tooltip title={t('admin.queue.pause.hint')}>
                  <QuestionCircleOutlined />
                </Tooltip>
              </Space>
            ),
            key: 'runs',
            align: 'center' as const,
            render: (_: unknown, queue: QueueDepthDto) => (
              <Switch
                size="small"
                // Reads as what it is: on means the stage runs. Inverted from the value it holds,
                // because "paused" as a switch you turn *on* to stop things is a double negative.
                checked={!paused.includes(queue.name)}
                disabled={settings.data === undefined}
                loading={saveSettings.isPending}
                aria-label={t('admin.queue.pause.switch', { queue: queue.name })}
                onChange={(runs) => togglePause(queue.name, !runs)}
              />
            ),
          },
        ]}
      />
    </Card>
  );

  // How one document's run behaves: how many of its units go at once, and the language the analysis
  // writes in. Both belong to this tab because both are about the inside of a run (docs/11 §11.13).
  const pipelineSettings = (
    <Card size="small" type="inner" title={t('admin.queue.pipeline.howTitle')}>
      <Space size="large" wrap align="end">
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
              aria-label={t('admin.queue.settings.unitConcurrency')}
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
        <Button
          type="primary"
          loading={saveSettings.isPending}
          disabled={draft === null || !unitsChanged}
          onClick={saveDraft}
        >
          {t('common.actions.save')}
        </Button>
        {/* One language for everything the machine writes, so an archive does not end up with a
            Russian title over an English description (docs/05 §5.5). */}
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
    </Card>
  );

  const steps = (
    <PipelineSteps
      steps={overview.data?.documents.steps ?? []}
      total={overview.data?.documents.total ?? 0}
      onRunAgain={(request) => reprocess.mutate(request)}
      running={reprocess.isPending ? (reprocess.variables ?? null) : null}
      pausedSteps={pausedSteps}
      onTogglePause={togglePauseStep}
      pausing={saveSettings.isPending}
      ready={settings.data !== undefined}
      gates={overview.data?.gates ?? []}
      // A configured Docling is one this instance resolved an address for (docs/05 §5.4c).
      doclingConfigured={healthOf('docling')?.status !== 'NOT_CONFIGURED'}
    />
  );

  // A tab of its own, because a service is not a stage and one container serves several: Stirling
  // renders pages for document-process and converts an upload for file-ingest, so its gate belongs to
  // neither stage and to both (docs/11 §11.13, docs/05 §5.4b).
  const servicesCard = (
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
              // 🔒 The answer to "is the throttle working", and the only honest witness to it: a step
              // waiting at a gate reads as RUNNING exactly like a step doing the work
              // (docs/05 §5.4b).
              title: (
                <Space size={4}>
                  {t('admin.queue.services.gateState')}
                  <Tooltip title={t('admin.queue.services.gateStateHint')}>
                    <QuestionCircleOutlined />
                  </Tooltip>
                </Space>
              ),
              key: 'gate',
              render: (_: unknown, service: ServiceName) => (
                <GateState state={gateOf(service)} pending={overview.isPending} />
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
  );

  const storageCard = (
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
  );

  const failuresCard = (
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
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row align="middle" justify="space-between">
        <Col>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('admin.queue.title')}
          </Typography.Title>
        </Col>
        <Col>
          {/* 🔒 Not called a pause: this screen already has two switches that stop real work — a
              stage's and a step's — and a third one that only stops the numbers moving was the
              difference between reading this page and misreading it (docs/11 §11.13). */}
          <Space>
            <Typography.Text type="secondary">{t('admin.queue.autoRefresh')}</Typography.Text>
            <Switch
              checked={live}
              onChange={setLive}
              aria-label={t('admin.queue.autoRefresh')}
              checkedChildren={t('admin.queue.refresh.on')}
              unCheckedChildren={t('admin.queue.refresh.off')}
            />
          </Space>
        </Col>
      </Row>

      {/* Four tabs, one question each (docs/11 §11.13). The open one is part of the address, and it
          switches on the press rather than after the navigation — a tab that waits for the router to
          come back feels broken (docs/10 §10.2). */}
      <Tabs
        activeKey={active}
        onChange={(key) => {
          if (!isAdminQueueTab(key)) return;
          setActive(key);
          router.replace(adminQueueHref(key));
        }}
        items={[
          {
            key: 'overview',
            label: t('admin.queue.tabs.overview'),
            children: (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                {summary}
                {stages}
                {storageCard}
              </Space>
            ),
          },
          {
            key: 'pipeline',
            label: t('admin.queue.tabs.pipeline'),
            children: (
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                {pipelineSettings}
                {steps}
              </Space>
            ),
          },
          {
            key: 'services',
            label: t('admin.queue.tabs.services'),
            children: servicesCard,
          },
          {
            key: 'failures',
            // The count travels on the label, so a failure is visible from the other three tabs
            // without opening this one (docs/11 §11.13).
            label: (
              <Space size={6}>
                {t('admin.queue.tabs.failures')}
                {failedRecent > 0 && <Tag color="red">{failedRecent}</Tag>}
              </Space>
            ),
            children: failuresCard,
          },
        ]}
      />
    </Space>
  );
}

// What a gate is doing, in the two numbers an operator reaches for and the one they cannot infer:
// how many calls are in flight, how many are waiting, and how long the one at the front has stood
// there (docs/05 §5.4b). 🔒 An ungated service says so in words rather than in three zeroes: nothing
// is being metered there, and a row of noughts reads as a throttle that is idle instead of one that
// is off.
function GateState({
  state,
  pending,
}: {
  state: ServiceGateSnapshotDto | undefined;
  pending: boolean;
}) {
  const t = useTranslations();
  if (state === undefined) {
    return pending ? <Spin size="small" /> : <Typography.Text type="secondary">—</Typography.Text>;
  }
  if (!state.gated) {
    return <Typography.Text type="secondary">{t('admin.queue.services.ungated')}</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text>
        {t('admin.queue.services.inFlight', { count: state.inFlight })}
      </Typography.Text>
      {state.waiting > 0 && (
        <Typography.Text type="warning">
          {t('admin.queue.services.waiting', {
            count: state.waiting,
            // Seconds, because a wait worth reporting is never milliseconds — and rounded down, so
            // "1 s" never appears over a wait that has not lasted one.
            seconds: Math.floor(state.longestWaitMs / 1000),
          })}
        </Typography.Text>
      )}
    </Space>
  );
}

// What is not in order, in one sentence, at the top of the Overview tab (docs/11 §11.13). Each part
// names the tab that deals with it, because "4 failures" is only useful next to the way to look at
// them. 🔒 When everything is in order it says so in as many words: an empty strip and a page that
// has not finished loading are the same picture, and one of them is worth worrying about.
function Summary({
  paused,
  pausedSteps,
  failedRecent,
  unhealthy,
  loading,
}: {
  paused: readonly string[];
  pausedSteps: readonly string[];
  failedRecent: number;
  unhealthy: readonly ServiceHealthDto[];
  loading: boolean;
}) {
  const t = useTranslations();
  if (loading) return <Spin size="small" />;

  // Each note carries its own name as its key: what is wrong decides what is drawn, so the position
  // in the list is not an identity.
  const notes: { key: string; node: ReactNode }[] = [];
  if (paused.length > 0) {
    notes.push({
      key: 'stages',
      // No link: the rows that answer it are directly below, on this same tab.
      node: t('admin.queue.summary.pausedStages', {
        stages: paused.map((queue) => t(`admin.queue.names.${queue}`)).join(', '),
      }),
    });
  }
  if (pausedSteps.length > 0) {
    notes.push({
      key: 'steps',
      node: (
        <Link href={adminQueueHref('pipeline')}>
          {t('admin.queue.summary.pausedSteps', {
            steps: pausedSteps.map((step) => t(`viewer.steps.${step}`)).join(', '),
          })}
        </Link>
      ),
    });
  }
  if (unhealthy.length > 0) {
    notes.push({
      key: 'services',
      node: (
        <Link href={adminQueueHref('services')}>
          {t('admin.queue.summary.services', {
            services: unhealthy
              .map((health) => t(`admin.queue.services.names.${health.service}`))
              .join(', '),
          })}
        </Link>
      ),
    });
  }
  if (failedRecent > 0) {
    notes.push({
      key: 'failures',
      node: (
        <Link href={adminQueueHref('failures')}>
          {t('admin.queue.summary.failures', { count: failedRecent })}
        </Link>
      ),
    });
  }

  if (notes.length === 0) {
    return <Alert type="success" showIcon message={t('admin.queue.summary.ok')} />;
  }
  return (
    <Alert
      type="warning"
      showIcon
      message={
        // Separated rather than listed: this is one sentence about several things, and a bullet list
        // of four words each would be taller than the table it introduces.
        <Space size={8} wrap split={<Typography.Text type="secondary">·</Typography.Text>}>
          {notes.map((note) => (
            <span key={note.key}>{note.node}</span>
          ))}
        </Space>
      }
    />
  );
}

// Which service does a step, and whether anybody is waiting for it. The mapping is the journal's own
// (docs/03 §3.3.18): the two that build and render the canonical go to Stirling, the extraction to
// Docling where there is one, and the readings to the analyst and the embeddings.
function serviceOfStep(step: DocumentStep, doclingConfigured: boolean): ServiceName | null {
  if (step === 'canonical' || step === 'preview') return 'stirling';
  if (step === 'markdown') return doclingConfigured ? 'docling' : 'stirling';
  if (step === 'analysis' || step === 'fields') return 'classifier';
  return 'embeddings';
}

function WaitingForService({
  step,
  gates,
  doclingConfigured,
}: {
  step: DocumentStep;
  gates: readonly ServiceGateSnapshotDto[];
  doclingConfigured: boolean;
}) {
  const t = useTranslations();
  const service = serviceOfStep(step, doclingConfigured);
  const gate = gates.find((row) => row.service === service);
  if (gate === undefined || !gate.gated || gate.waiting === 0) return null;
  return (
    <Tag color="gold">
      {t('admin.queue.pipeline.waitingFor', {
        service: t(`admin.queue.services.names.${gate.service}`),
        count: gate.waiting,
      })}
    </Tag>
  );
}

// One line per status that actually has documents in it; a step with nothing in a status should not
// spend a row saying zero. In the statuses' own order rather than the server's, so the rows
// read alike.
// The steps of the pipeline, as the document's own page names them (docs/11 §11.5): one screen
// calling the same step "Тип" and the other "Анализ" is two names for one thing, and the reader has
// to work out that they are the same.
function PipelineSteps({
  steps,
  total,
  onRunAgain,
  running,
  pausedSteps,
  onTogglePause,
  pausing,
  ready,
  gates,
  doclingConfigured,
}: {
  steps: readonly StepCountersDto[];
  total: number;
  onRunAgain: (request: ReprocessByStepRequest) => void;
  // The request being run right now, if any — so exactly the button that was pressed spins.
  running: ReprocessByStepRequest | null;
  // The steps this instance is holding (docs/05 §5.4d): tagged here, and not offered a re-run.
  pausedSteps: readonly string[];
  onTogglePause: (step: DocumentStep, pause: boolean) => void;
  pausing: boolean;
  ready: boolean;
  // What each gate is doing, so a step whose service has callers waiting says so (docs/05 §5.4b).
  gates: readonly ServiceGateSnapshotDto[];
  // Whether Docling is configured: the markdown step goes to it when it is, and falls back to
  // Stirling's converter when it is not, exactly as the journal records (docs/05 §5.5 step 3).
  doclingConfigured: boolean;
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
                {/* On means the step runs, as the switch on the stage above reads: the two paused
                    things on this page must read alike (docs/11 §11.13). */}
                <Tooltip title={t('admin.queue.pause.stepHint')}>
                  <Switch
                    size="small"
                    checked={!pausedSteps.includes(row.step)}
                    disabled={!ready}
                    loading={pausing}
                    aria-label={t('admin.queue.pause.stepSwitch', {
                      step: t(`viewer.steps.${row.step}`),
                    })}
                    onChange={(runs) => onTogglePause(row.step, !runs)}
                  />
                </Tooltip>
                <Typography.Text strong>{t(`viewer.steps.${row.step}`)}</Typography.Text>
                {/* 🔒 Two documents both reading RUNNING at one step is what a gate of one looks
                    like: one is working and the other is standing at it, because waiting at a gate
                    is time inside the job (docs/05 §5.4b). Without this the table is unreadable at
                    the one moment it matters. */}
                <WaitingForService
                  step={row.step}
                  gates={gates}
                  doclingConfigured={doclingConfigured}
                />
                {pausedSteps.includes(row.step) ? (
                  // Tagged beside its counts, the way a paused queue is tagged beside its depth: a
                  // growing count must never be mistaken for a stuck one.
                  <Tag color="orange">{t('admin.queue.pause.tag')}</Tag>
                ) : (
                  <RunAgain
                    label={t('admin.queue.actions.runStep')}
                    loading={
                      running !== null && running.step === row.step && running.status === undefined
                    }
                    onClick={() => onRunAgain({ step: row.step })}
                  />
                )}
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
                  {/* 🔒 A held step is offered no re-run at all: the server refuses one, and an
                      icon that answers 409 is worse than an icon that is not there. */}
                  {!pausedSteps.includes(row.step) && (
                    <RunAgain
                      label={t('admin.queue.actions.runAgain')}
                      loading={
                        running !== null && running.step === row.step && running.status === status
                      }
                      onClick={() => onRunAgain({ step: row.step, status })}
                    />
                  )}
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
