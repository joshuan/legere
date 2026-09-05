'use client';

import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  InputNumber,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { GlobalToken } from 'antd';
import { stepStatusSchema, type StepStatus } from '../../../shared/contracts/enums';
import type {
  ProcessingBlockerDto,
  ProcessingSnapshotResponse,
  ProcessingTopologyDto,
  ResolvedBooleanSettingDto,
  ResolvedNumberSettingDto,
} from '../../../shared/contracts/processing';
import {
  QUEUE_CONCURRENCY_MAX,
  SERVICE_COOLDOWN_MAX_SECONDS,
  type FailedJobDto,
  type ReprocessByStepRequest,
  type ServiceHealthStatus,
  type VectorCounts,
} from '../../../shared/contracts/queue';
import { analysisSettingsApi, queueKeys } from '../../entities/queue';
import { processingApi, processingKeys } from '../../entities/processing';
import { formatBytes, useErrorMessage } from '../../shared/lib';
import {
  adminProcessingHref,
  isAdminProcessingTab,
  type AdminProcessingTab,
} from './admin-queue-tab';

const REFRESH_MS = 5_000;
const SERVICES_REFRESH_MS = 60_000;

type QueueRow = ProcessingSnapshotResponse['queues'][number];
type PipelineRow = ProcessingSnapshotResponse['pipeline']['steps'][number];
type ServiceRow = ProcessingSnapshotResponse['services'][number];
type ServiceHealth = NonNullable<ServiceRow['health']['value']>;
type QueueTopology = ProcessingTopologyDto['queues'][number];
type StepTopology = ProcessingTopologyDto['pipeline']['steps'][number];
type ServiceTopology = ProcessingTopologyDto['services'][number];

export function AdminProcessingScreen({ tab = 'overview' }: { tab?: AdminProcessingTab }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [pendingTab, setPendingTab] = useState<{
    from: AdminProcessingTab;
    to: AdminProcessingTab;
  } | null>(null);
  const active = pendingTab?.from === tab ? pendingTab.to : tab;

  // Overview, Pipeline and Services are three projections of this one read model. In particular,
  // no client-owned step/service map can drift from the worker topology.
  const snapshot = useQuery({
    queryKey: processingKeys.snapshot,
    queryFn: processingApi.snapshot,
    refetchInterval: live ? REFRESH_MS : false,
  });

  const failures = useInfiniteQuery({
    queryKey: processingKeys.failures,
    queryFn: ({ pageParam }) => processingApi.failures(pageParam === '' ? null : pageParam),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: active === 'failures',
    refetchInterval: live && active === 'failures' ? REFRESH_MS : false,
  });

  const analysis = useQuery({
    queryKey: queueKeys.analysis,
    queryFn: analysisSettingsApi.read,
    enabled: active === 'pipeline',
  });
  const [languageDraft, setLanguageDraft] = useState<{ value: string | undefined } | null>(null);
  const language =
    languageDraft === null
      ? analysis.data?.language === ''
        ? undefined
        : analysis.data?.language
      : languageDraft.value;
  const saveAnalysis = useMutation({
    mutationFn: analysisSettingsApi.save,
    onSuccess: () => {
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: queueKeys.analysis });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    void queryClient.invalidateQueries({ queryKey: processingKeys.failures });
  }, [queryClient]);

  const retry = useMutation({
    mutationFn: processingApi.retry,
    onSuccess: () => {
      void message.success(t('admin.queue.retried'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const reprocess = useMutation({
    mutationFn: processingApi.reprocess,
    onSuccess: (result) => {
      void message.success(t('admin.queue.reprocess.enqueued', { count: result.enqueued }), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const checkServices = useMutation({
    mutationFn: processingApi.checkServices,
    onSuccess: () => {
      void message.success(t('admin.queue.services.checked'), 2);
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const checkServicesNow = checkServices.mutate;
  useEffect(() => {
    if (active !== 'services') return;
    checkServicesNow();
    if (!live) return;
    const timer = window.setInterval(checkServicesNow, SERVICES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, checkServicesNow, live]);

  const data = snapshot.data;
  const failedRecent = (data?.queues ?? []).reduce(
    (total, queue) => total + queue.runtime.failedRecent,
    0,
  );

  const overview = data === undefined ? <Spin /> : <OverviewTab snapshot={data} />;
  const pipeline =
    data === undefined ? (
      <Spin />
    ) : (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <PipelineSettings
          snapshot={data}
          language={language}
          onLanguageChange={(value) => setLanguageDraft({ value })}
          onSaveLanguage={() => saveAnalysis.mutate({ language: language ?? '' })}
          languageReady={analysis.data !== undefined}
          languageSaving={saveAnalysis.isPending}
        />
        <PipelineTable
          snapshot={data}
          onRunAgain={(request) => reprocess.mutate(request)}
          running={reprocess.isPending ? (reprocess.variables ?? null) : null}
        />
      </Space>
    );
  const services =
    data === undefined ? (
      <Spin />
    ) : (
      <ServicesTab
        snapshot={data}
        checking={checkServices.isPending}
        onCheck={() => checkServices.mutate()}
      />
    );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('admin.queue.title')}
        </Typography.Title>
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
      </Space>

      {snapshot.isError && <Alert type="error" showIcon message={describeError(snapshot.error)} />}
      {data !== undefined && <ControlPlaneState snapshot={data} />}

      <Tabs
        activeKey={active}
        onChange={(key) => {
          if (!isAdminProcessingTab(key)) return;
          setPendingTab({ from: tab, to: key });
          router.replace(adminProcessingHref(key));
        }}
        items={[
          { key: 'overview', label: t('admin.queue.tabs.overview'), children: overview },
          { key: 'pipeline', label: t('admin.queue.tabs.pipeline'), children: pipeline },
          { key: 'services', label: t('admin.queue.tabs.services'), children: services },
          {
            key: 'failures',
            label: (
              <Space size={6}>
                {t('admin.queue.tabs.failures')}
                {failedRecent > 0 && <Tag color="red">{failedRecent}</Tag>}
              </Space>
            ),
            children: (
              <FailuresTable
                jobs={failures.data?.pages.flatMap((page) => page.items) ?? []}
                loading={failures.isPending}
                hasMore={failures.hasNextPage}
                loadingMore={failures.isFetchingNextPage}
                onLoadMore={() => void failures.fetchNextPage()}
                retrying={retry.isPending ? (retry.variables ?? null) : null}
                onRetry={(jobId) => retry.mutate(jobId)}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}

function ControlPlaneState({ snapshot }: { snapshot: ProcessingSnapshotResponse }) {
  const t = useTranslations();
  const blockers = [
    ...snapshot.queues.flatMap((queue) => queue.blockers),
    ...snapshot.pipeline.steps.flatMap((step) => step.blockers),
  ];
  const status = snapshot.apply.status;
  const type =
    status === 'DEGRADED' ? 'error' : status === 'APPLIED_WITH_WARNINGS' ? 'warning' : 'success';
  return (
    <Alert
      type={type}
      showIcon
      message={t(`admin.queue.apply.${status}`)}
      description={
        <Space direction="vertical" size={2}>
          <Typography.Text>
            {t('admin.queue.apply.revisions', {
              desired: snapshot.apply.desiredRevision,
              applied: snapshot.apply.appliedRevision ?? '—',
            })}
          </Typography.Text>
          {snapshot.apply.detail !== null && (
            <Typography.Text>{snapshot.apply.detail}</Typography.Text>
          )}
          {blockers.length > 0 && (
            <Typography.Text type="secondary">
              {t('admin.queue.apply.blockers', { count: blockers.length })}
            </Typography.Text>
          )}
          <Typography.Text type="secondary">
            {t('admin.queue.apply.generatedAt', {
              time: new Date(snapshot.generatedAt).toLocaleString(),
            })}
          </Typography.Text>
        </Space>
      }
    />
  );
}

function OverviewTab({ snapshot }: { snapshot: ProcessingSnapshotResponse }) {
  const t = useTranslations();
  const storage = snapshot.storage;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <TopologyStrip topology={snapshot.topology} />
      <Card title={t('admin.queue.stages.title')}>
        <Table<QueueRow>
          size="small"
          rowKey="name"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={[...snapshot.queues]}
          columns={[
            {
              title: t('admin.queue.stages.stage'),
              key: 'stage',
              render: (_, row) => (
                <QueueIdentity
                  row={row}
                  topology={snapshot.topology.queues.find((item) => item.name === row.name)}
                />
              ),
            },
            {
              title: t('admin.queue.queued'),
              key: 'queued',
              render: (_, row) => row.runtime.queued,
            },
            {
              title: t('admin.queue.active'),
              key: 'active',
              render: (_, row) => row.runtime.active,
            },
            {
              title: t('admin.queue.failedRecent'),
              key: 'failed',
              render: (_, row) =>
                row.runtime.failedRecent === 0 ? null : (
                  <Typography.Text type="danger">{row.runtime.failedRecent}</Typography.Text>
                ),
            },
            {
              title: t('admin.queue.liveness.completedLastHour'),
              key: 'completedLastHour',
              render: (_, row) => row.runtime.completedLastHour,
            },
            {
              title: t('admin.queue.liveness.oldestQueuedAt'),
              key: 'oldestQueuedAt',
              render: (_, row) => (
                <Timestamp
                  value={row.runtime.oldestQueuedAt}
                  empty={t('admin.queue.liveness.noQueuedWork')}
                />
              ),
            },
            {
              title: t('admin.queue.liveness.lastCompletedAt'),
              key: 'lastCompletedAt',
              render: (_, row) => (
                <Timestamp
                  value={row.runtime.lastCompletedAt}
                  empty={t('admin.queue.liveness.noRetainedCompletion')}
                />
              ),
            },
            {
              title: t('admin.queue.settings.concurrency'),
              key: 'control',
              render: (_, row) => <QueueControls row={row} revision={snapshot.revision} />,
            },
            {
              title: t('admin.queue.blockers.title'),
              key: 'blockers',
              render: (_, row) => <Blockers blockers={row.blockers} />,
            },
          ]}
        />
      </Card>

      <Card title={t('admin.queue.storage.title')}>
        {storage === null ? (
          <Typography.Text type="secondary">{t('admin.queue.storage.pending')}</Typography.Text>
        ) : (
          <Space size="large" wrap>
            <Statistic title={t('admin.queue.storage.objects')} value={storage.objects} />
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
    </Space>
  );
}

function TopologyStrip({ topology }: { topology: ProcessingTopologyDto }) {
  const t = useTranslations();
  return (
    <Card size="small" title={t('admin.queue.topology.title')}>
      <Space size={6} wrap>
        {topology.queues.map((queue) => (
          <Tag key={queue.name} color={queue.name === topology.pipeline.queue ? 'blue' : 'default'}>
            {queue.name}
            {' → '}
            {queue.produces.length > 0
              ? queue.produces.join(', ')
              : t('admin.queue.topology.terminal')}
          </Tag>
        ))}
        {topology.pipeline.steps.map((step) => (
          <Tag key={step.step} color="purple">
            {step.dependencies.length > 0
              ? `${step.dependencies.map((dependency) => t(`viewer.steps.${dependency.step}`)).join(' + ')} → `
              : ''}
            {t(`viewer.steps.${step.step}`)}
          </Tag>
        ))}
      </Space>
    </Card>
  );
}

function QueueIdentity({ row, topology }: { row: QueueRow; topology: QueueTopology | undefined }) {
  const t = useTranslations();
  return (
    <Space direction="vertical" size={0}>
      <Space size={6} wrap>
        <Typography.Text strong>{t(`admin.queue.names.${row.name}`)}</Typography.Text>
        <Typography.Text code type="secondary">
          {row.name}
        </Typography.Text>
        {!row.runtime.registered && <Tag color="red">{t('admin.queue.runtime.unregistered')}</Tag>}
      </Space>
      <Typography.Text type="secondary">{t(`admin.queue.hints.${row.name}`)}</Typography.Text>
      {topology !== undefined && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t(`admin.queue.topology.kind.${topology.kind}`)} · {topology.policy} ·{' '}
          {t('admin.queue.topology.expiry', { seconds: topology.expireInSeconds })}
          {topology.produces.length > 0
            ? ` · ${t('admin.queue.topology.produces', { queues: topology.produces.join(', ') })}`
            : ''}
        </Typography.Text>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('admin.queue.runtime.appliedConcurrency', {
          value: row.runtime.appliedConcurrency ?? '—',
        })}
      </Typography.Text>
    </Space>
  );
}

type NumberDraft = { value: number; baseRevision: number };

function QueueControls({ row, revision }: { row: QueueRow; revision: number }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<NumberDraft | null>(null);
  const update = useMutation({
    mutationFn: (change: {
      expectedRevision: number;
      concurrency?: number | null;
      paused?: boolean;
    }) => processingApi.updateQueue(row.name, change),
    onSuccess: () => {
      setDraft(null);
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
      void message.error(describeError(error));
    },
  });
  const control = row.control.concurrency;
  return (
    <Space direction="vertical" size={4}>
      <Space size={4}>
        <InputNumber
          min={1}
          max={QUEUE_CONCURRENCY_MAX}
          style={{ width: 72 }}
          aria-label={t('admin.queue.settings.concurrencyFor', {
            stage: t(`admin.queue.names.${row.name}`),
          })}
          value={draft?.value ?? control.effective}
          disabled={update.isPending}
          onChange={(value) =>
            setDraft((current) => ({
              value: value ?? control.effective,
              baseRevision: current?.baseRevision ?? revision,
            }))
          }
        />
        <Button
          size="small"
          type="primary"
          disabled={draft === null}
          loading={update.isPending}
          onClick={() => {
            if (draft !== null) {
              update.mutate({ expectedRevision: draft.baseRevision, concurrency: draft.value });
            }
          }}
        >
          {t('common.actions.save')}
        </Button>
        {control.source === 'OVERRIDE' && (
          <Button
            size="small"
            disabled={update.isPending}
            onClick={() => update.mutate({ expectedRevision: revision, concurrency: null })}
          >
            {t('admin.queue.settings.useDefault')}
          </Button>
        )}
      </Space>
      <ResolvedSetting setting={control} />
      <Space size={6}>
        <Switch
          size="small"
          checked={!row.control.paused.effective}
          loading={update.isPending}
          aria-label={t('admin.queue.pause.switch', { queue: row.name })}
          onChange={(runs) => update.mutate({ expectedRevision: revision, paused: !runs })}
        />
        <Typography.Text type="secondary">{t('admin.queue.pause.title')}</Typography.Text>
        <ResolvedBooleanSetting setting={row.control.paused} />
      </Space>
    </Space>
  );
}

function PipelineSettings({
  snapshot,
  language,
  onLanguageChange,
  onSaveLanguage,
  languageReady,
  languageSaving,
}: {
  snapshot: ProcessingSnapshotResponse;
  language: string | undefined;
  onLanguageChange: (value: string | undefined) => void;
  onSaveLanguage: () => void;
  languageReady: boolean;
  languageSaving: boolean;
}) {
  const t = useTranslations();
  return (
    <Card size="small" type="inner" title={t('admin.queue.pipeline.howTitle')}>
      <Space size="large" wrap align="end">
        <PipelineConcurrency
          setting={snapshot.pipeline.unitConcurrency}
          revision={snapshot.revision}
        />
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
              onChange={onLanguageChange}
              options={LANGUAGE_OPTIONS}
            />
          )}
        />
        <Button loading={languageSaving} disabled={!languageReady} onClick={onSaveLanguage}>
          {t('common.actions.save')}
        </Button>
      </Space>
    </Card>
  );
}

function PipelineConcurrency({
  setting,
  revision,
}: {
  setting: ResolvedNumberSettingDto;
  revision: number;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<NumberDraft | null>(null);
  const update = useMutation({
    mutationFn: (body: { expectedRevision: number; unitConcurrency: number | null }) =>
      processingApi.updatePipeline(body),
    onSuccess: () => {
      setDraft(null);
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
      void message.error(describeError(error));
    },
  });
  return (
    <Space direction="vertical" size={4}>
      <Typography.Text>{t('admin.queue.settings.unitConcurrency')}</Typography.Text>
      <Space size={4}>
        <InputNumber
          min={1}
          max={QUEUE_CONCURRENCY_MAX}
          aria-label={t('admin.queue.settings.unitConcurrency')}
          value={draft?.value ?? setting.effective}
          disabled={update.isPending}
          onChange={(value) =>
            setDraft((current) => ({
              value: value ?? setting.effective,
              baseRevision: current?.baseRevision ?? revision,
            }))
          }
        />
        <Button
          type="primary"
          disabled={draft === null}
          loading={update.isPending}
          onClick={() => {
            if (draft !== null) {
              update.mutate({
                expectedRevision: draft.baseRevision,
                unitConcurrency: draft.value,
              });
            }
          }}
        >
          {t('common.actions.save')}
        </Button>
        {setting.source === 'OVERRIDE' && (
          <Button
            disabled={update.isPending}
            onClick={() => update.mutate({ expectedRevision: revision, unitConcurrency: null })}
          >
            {t('admin.queue.settings.useDefault')}
          </Button>
        )}
      </Space>
      <ResolvedSetting setting={setting} />
    </Space>
  );
}

function PipelineTable({
  snapshot,
  onRunAgain,
  running,
}: {
  snapshot: ProcessingSnapshotResponse;
  onRunAgain: (request: ReprocessByStepRequest) => void;
  running: ReprocessByStepRequest | null;
}) {
  const t = useTranslations();
  const { token } = theme.useToken();
  return (
    <Card
      title={t('admin.queue.pipeline.title')}
      extra={
        <Space>
          <Typography.Text type="secondary">
            {t('admin.queue.pipeline.total', { count: snapshot.pipeline.totalDocuments })}
          </Typography.Text>
          <RunAgain
            label={t('admin.queue.actions.runAll')}
            loading={running !== null && running.step === undefined}
            onClick={() => onRunAgain({})}
          />
        </Space>
      }
    >
      <Table<PipelineRow>
        size="small"
        rowKey="step"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={[...snapshot.pipeline.steps]}
        columns={[
          {
            title: t('admin.queue.pipeline.step'),
            key: 'step',
            render: (_, row) => (
              <StepIdentity
                row={row}
                topology={snapshot.topology.pipeline.steps.find((item) => item.step === row.step)}
                services={snapshot.services}
                revision={snapshot.revision}
                onRunAgain={onRunAgain}
                running={running}
                vectors={snapshot.vectors}
              />
            ),
          },
          ...stepStatusSchema.options.map((status) => ({
            title: (
              <Typography.Text style={{ color: statusColor(status, token) }}>
                {t(`documents.filters.stepStatus.${status}`)}
              </Typography.Text>
            ),
            key: status,
            render: (_: unknown, row: PipelineRow) => {
              const count = row.counts[status] ?? 0;
              if (count === 0) return null;
              return (
                <Space size={4}>
                  <Link href={`/documents?step=${row.step}&stepStatus=${status}`}>{count}</Link>
                  {!row.control.paused.effective && (
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

function StepIdentity({
  row,
  topology,
  services,
  revision,
  onRunAgain,
  running,
  vectors,
}: {
  row: PipelineRow;
  topology: StepTopology | undefined;
  services: readonly ServiceRow[];
  revision: number;
  onRunAgain: (request: ReprocessByStepRequest) => void;
  running: ReprocessByStepRequest | null;
  vectors: VectorCounts;
}) {
  const t = useTranslations();
  return (
    <Space direction="vertical" size={3}>
      <Space size={5} wrap>
        <StepPause row={row} revision={revision} />
        <Typography.Text strong>{t(`viewer.steps.${row.step}`)}</Typography.Text>
        <ResolvedBooleanSetting setting={row.control.paused} />
        {!row.control.paused.effective && (
          <RunAgain
            label={t('admin.queue.actions.runStep')}
            loading={running !== null && running.step === row.step && running.status === undefined}
            onClick={() => onRunAgain({ step: row.step })}
          />
        )}
        {row.step === 'vectorization' && <Vectors counts={vectors} />}
      </Space>
      {topology !== undefined && <StepRelationships topology={topology} services={services} />}
      <Blockers blockers={row.blockers} />
    </Space>
  );
}

function StepPause({ row, revision }: { row: PipelineRow; revision: number }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const update = useMutation({
    mutationFn: (paused: boolean) =>
      processingApi.updateStep(row.step, { expectedRevision: revision, paused }),
    onSuccess: (result) => {
      const resumed = result.resumed.reduce((total, item) => total + item.documents, 0);
      void message.success(
        resumed > 0
          ? t('admin.queue.settings.resumedWork', { count: resumed })
          : t('admin.queue.settings.saved'),
        2,
      );
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
      void message.error(describeError(error));
    },
  });
  return (
    <Tooltip title={t('admin.queue.pause.stepHint')}>
      <Switch
        size="small"
        checked={!row.control.paused.effective}
        loading={update.isPending}
        aria-label={t('admin.queue.pause.stepSwitch', { step: t(`viewer.steps.${row.step}`) })}
        onChange={(runs) => update.mutate(!runs)}
      />
    </Tooltip>
  );
}

function StepRelationships({
  topology,
  services,
}: {
  topology: StepTopology;
  services: readonly ServiceRow[];
}) {
  const t = useTranslations();
  return (
    <Space size={4} wrap>
      {topology.dependencies.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('admin.queue.topology.noDependencies')}
        </Typography.Text>
      ) : (
        topology.dependencies.map((dependency) => (
          <Tooltip
            key={`${dependency.step}-${dependency.kind}`}
            title={t(`admin.queue.topology.holdWhen.${dependency.holdWhen}`)}
          >
            <Tag>
              {t('admin.queue.topology.dependsOn', {
                step: t(`viewer.steps.${dependency.step}`),
              })}
            </Tag>
          </Tooltip>
        ))
      )}
      {topology.resources.map((resource) => {
        const runtime = services.find((service) => service.service === resource.service);
        const waiting = runtime?.gate.waiting ?? 0;
        return (
          <Tooltip
            key={`${resource.service}-${resource.role}-${resource.when}`}
            title={t('admin.queue.topology.resourceDetail', {
              role: t(`admin.queue.topology.role.${resource.role}`),
              when: t(`admin.queue.topology.when.${resource.when}`),
            })}
          >
            <Tag color={waiting > 0 ? 'gold' : 'blue'}>
              {t(`admin.queue.services.names.${resource.service}`)}
              {waiting > 0
                ? ` · ${t('admin.queue.services.waitingShort', { count: waiting })}`
                : ''}
            </Tag>
          </Tooltip>
        );
      })}
    </Space>
  );
}

function ServicesTab({
  snapshot,
  checking,
  onCheck,
}: {
  snapshot: ProcessingSnapshotResponse;
  checking: boolean;
  onCheck: () => void;
}) {
  const t = useTranslations();
  return (
    <Card
      title={t('admin.queue.services.title')}
      extra={
        <Button
          size="small"
          icon={<ReloadOutlined aria-hidden />}
          loading={checking}
          onClick={onCheck}
        >
          {t('admin.queue.services.check')}
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('admin.queue.services.hint')}</Typography.Text>
        <Table<ServiceRow>
          size="small"
          rowKey="service"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={[...snapshot.services]}
          columns={[
            {
              title: t('admin.queue.services.service'),
              key: 'service',
              render: (_, row) => (
                <ServiceIdentity
                  row={row}
                  topology={snapshot.topology.services.find((item) => item.service === row.service)}
                />
              ),
            },
            {
              title: t('admin.queue.services.state'),
              key: 'health',
              render: (_, row) => <ServiceState health={row.health} />,
            },
            {
              title: t('admin.queue.services.gateState'),
              key: 'gate',
              render: (_, row) => <GateState row={row} />,
            },
            {
              title: t('admin.queue.services.controls'),
              key: 'controls',
              render: (_, row) => <ServiceControls row={row} revision={snapshot.revision} />,
            },
          ]}
        />
      </Space>
    </Card>
  );
}

function ServiceIdentity({
  row,
  topology,
}: {
  row: ServiceRow;
  topology: ServiceTopology | undefined;
}) {
  const t = useTranslations();
  return (
    <Space direction="vertical" size={0}>
      <Space size={6}>
        <Typography.Text strong>{t(`admin.queue.services.names.${row.service}`)}</Typography.Text>
        <Typography.Text code type="secondary">
          {row.service}
        </Typography.Text>
      </Space>
      {topology !== undefined && (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('admin.queue.topology.steps', {
              steps: topology.steps.map((step) => t(`viewer.steps.${step}`)).join(', ') || '—',
            })}
          </Typography.Text>
          {topology.otherConsumers.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('admin.queue.topology.otherConsumers', {
                consumers: topology.otherConsumers.join(', '),
              })}
            </Typography.Text>
          )}
        </>
      )}
      <ServiceAddress health={row.health.value} />
    </Space>
  );
}

type ServiceDraft = {
  concurrency: number;
  cooldownSeconds: number;
  baseRevision: number;
};

function ServiceControls({ row, revision }: { row: ServiceRow; revision: number }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const update = useMutation({
    mutationFn: (body: {
      expectedRevision: number;
      concurrency?: number | null;
      cooldownSeconds?: number | null;
    }) => processingApi.updateService(row.service, body),
    onSuccess: () => {
      setDraft(null);
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => {
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
      void message.error(describeError(error));
    },
  });
  const current: ServiceDraft = draft ?? {
    concurrency: row.control.concurrency.effective,
    cooldownSeconds: row.control.cooldownSeconds.effective,
    baseRevision: revision,
  };
  const edit = (change: Partial<Pick<ServiceDraft, 'concurrency' | 'cooldownSeconds'>>): void =>
    setDraft((held) => ({
      concurrency: held?.concurrency ?? row.control.concurrency.effective,
      cooldownSeconds: held?.cooldownSeconds ?? row.control.cooldownSeconds.effective,
      baseRevision: held?.baseRevision ?? revision,
      ...change,
    }));
  return (
    <Space direction="vertical" size={5}>
      <Space size={6} wrap>
        <InputNumber
          min={0}
          max={QUEUE_CONCURRENCY_MAX}
          style={{ width: 80 }}
          aria-label={t('admin.queue.services.concurrencyFor', {
            service: t(`admin.queue.services.names.${row.service}`),
          })}
          value={current.concurrency}
          disabled={update.isPending}
          onChange={(value) => edit({ concurrency: value ?? 0 })}
        />
        <InputNumber
          min={0}
          max={SERVICE_COOLDOWN_MAX_SECONDS}
          style={{ width: 80 }}
          aria-label={t('admin.queue.services.cooldownFor', {
            service: t(`admin.queue.services.names.${row.service}`),
          })}
          value={current.cooldownSeconds}
          disabled={update.isPending}
          onChange={(value) => edit({ cooldownSeconds: value ?? 0 })}
        />
        <Button
          size="small"
          type="primary"
          disabled={draft === null}
          loading={update.isPending}
          onClick={() =>
            update.mutate({
              expectedRevision: current.baseRevision,
              concurrency: current.concurrency,
              cooldownSeconds: current.cooldownSeconds,
            })
          }
        >
          {t('common.actions.save')}
        </Button>
        {row.control.concurrency.source === 'OVERRIDE' && (
          <Button
            size="small"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                expectedRevision: revision,
                concurrency: null,
              })
            }
          >
            {t('admin.queue.services.resetConcurrency')}
          </Button>
        )}
        {row.control.cooldownSeconds.source === 'OVERRIDE' && (
          <Button
            size="small"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                expectedRevision: revision,
                cooldownSeconds: null,
              })
            }
          >
            {t('admin.queue.services.resetCooldown')}
          </Button>
        )}
      </Space>
      <Space size={8} wrap>
        <ResolvedSetting
          label={t('admin.queue.services.concurrency')}
          setting={row.control.concurrency}
        />
        <ResolvedSetting
          label={t('admin.queue.services.cooldown')}
          setting={row.control.cooldownSeconds}
        />
      </Space>
    </Space>
  );
}

function ResolvedSetting({
  setting,
  label,
}: {
  setting: ResolvedNumberSettingDto;
  label?: string;
}) {
  const t = useTranslations();
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {label === undefined ? '' : `${label}: `}
      {t('admin.queue.settings.effectiveDefault', {
        effective: setting.effective,
        default: setting.default,
      })}{' '}
      <SettingSource setting={setting} />
    </Typography.Text>
  );
}

function SettingSource({
  setting,
}: {
  setting: ResolvedNumberSettingDto | ResolvedBooleanSettingDto;
}) {
  const t = useTranslations();
  return <Tag>{t(`admin.queue.settings.source.${setting.source}`)}</Tag>;
}

function ResolvedBooleanSetting({ setting }: { setting: ResolvedBooleanSettingDto }) {
  const t = useTranslations();
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {t('admin.queue.settings.effectiveDefault', {
        effective: t(
          setting.effective
            ? 'admin.queue.settings.state.paused'
            : 'admin.queue.settings.state.running',
        ),
        default: t('admin.queue.settings.state.running'),
      })}{' '}
      <SettingSource setting={setting} />
    </Typography.Text>
  );
}

function Blockers({ blockers }: { blockers: readonly ProcessingBlockerDto[] }) {
  const t = useTranslations();
  if (blockers.length === 0) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  return (
    <Space size={3} wrap>
      {blockers.map((blocker) => (
        <Tag color="orange" key={JSON.stringify(blocker)}>
          {describeBlocker(blocker, t)}
        </Tag>
      ))}
    </Space>
  );
}

type Translate = ReturnType<typeof useTranslations>;

function describeBlocker(blocker: ProcessingBlockerDto, t: Translate): string {
  if (blocker.kind === 'QUEUE_PAUSED') {
    return t('admin.queue.blockers.queuePaused', { queue: blocker.queue });
  }
  if (blocker.kind === 'STEP_PAUSED') {
    return t('admin.queue.blockers.stepPaused', { step: t(`viewer.steps.${blocker.step}`) });
  }
  if (blocker.kind === 'DEPENDENCY_PAUSED') {
    return t('admin.queue.blockers.dependencyPaused', {
      path: blocker.path.map((step) => t(`viewer.steps.${step}`)).join(' → '),
    });
  }
  return t('admin.queue.blockers.runtimeDegraded', { detail: blocker.detail });
}

function GateState({ row }: { row: ServiceRow }) {
  const t = useTranslations();
  const gate = row.gate;
  if (!gate.gated && gate.throttledUntil === null) {
    return <Typography.Text type="secondary">{t('admin.queue.services.ungated')}</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={0}>
      {gate.throttledUntil === null ? (
        <Typography.Text>
          {t('admin.queue.services.inFlight', { count: gate.inFlight })}
        </Typography.Text>
      ) : (
        <Typography.Text type="warning">
          {t('admin.queue.services.throttledUntil', {
            time: new Date(gate.throttledUntil).toLocaleString(),
          })}
        </Typography.Text>
      )}
      {gate.waiting > 0 && (
        <Typography.Text type="warning">
          {t('admin.queue.services.waiting', {
            count: gate.waiting,
            seconds: Math.floor(gate.longestWaitMs / 1000),
          })}
        </Typography.Text>
      )}
    </Space>
  );
}

const HEALTH_COLORS: Record<ServiceHealthStatus, string> = {
  UP: 'success',
  UNAUTHORIZED: 'warning',
  ANSWERED: 'warning',
  DOWN: 'error',
  NOT_CONFIGURED: 'default',
};

function ServiceState({ health }: { health: ServiceRow['health'] }) {
  const t = useTranslations();
  if (health.value === null) {
    return <Tag>{t(`admin.queue.services.freshness.${health.freshness}`)}</Tag>;
  }
  return (
    <Space direction="vertical" size={2}>
      <Tooltip title={<ServiceStateDetail health={health.value} />}>
        <Tag color={HEALTH_COLORS[health.value.status]}>
          {t(`admin.queue.services.health.${health.value.status}`)}
        </Tag>
      </Tooltip>
      <Tag color={health.freshness === 'FRESH' ? 'success' : 'warning'}>
        {t(`admin.queue.services.freshness.${health.freshness}`)}
      </Tag>
    </Space>
  );
}

function ServiceStateDetail({ health }: { health: ServiceHealth }) {
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

function ServiceAddress({ health }: { health: ServiceHealth | null }) {
  const t = useTranslations();
  if (health === null) return null;
  if (health.url === '') {
    return (
      <Typography.Text type="secondary" italic style={{ fontSize: 12 }}>
        {t('admin.queue.services.addressUnset')}
      </Typography.Text>
    );
  }
  return (
    <Typography.Text type="secondary" code ellipsis={{ tooltip: health.url }}>
      {health.url}
    </Typography.Text>
  );
}

function FailuresTable({
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

function Vectors({ counts }: { counts: VectorCounts }) {
  const t = useTranslations();
  if (counts.chunks === 0) return null;
  const models = counts.byModel
    .map((row) => row.model ?? t('admin.queue.pipeline.vectorsUnknownModel'))
    .join(', ');
  return counts.byModel.length > 1 ? (
    <Tag color="orange">{t('admin.queue.pipeline.vectorsMixed', { models })}</Tag>
  ) : (
    <Typography.Text type="secondary">
      {t('admin.queue.pipeline.vectors', { chunks: counts.chunks, model: models })}
    </Typography.Text>
  );
}

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

function Timestamp({ value, empty }: { value: string | null; empty: string }) {
  const locale = useLocale();
  if (value === null) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return (
    <Tooltip title={new Date(value).toLocaleString(locale)}>{relativeTime(value, locale)}</Tooltip>
  );
}

function relativeTime(value: string, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, 'minute');
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 48) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.floor(hours / 24), 'day');
}

function statusColor(status: StepStatus, token: GlobalToken): string {
  if (status === 'DONE') return token.colorSuccess;
  if (status === 'FAILED') return token.colorError;
  if (status === 'QUEUED' || status === 'RUNNING') return token.colorInfo;
  if (status === 'PENDING') return token.colorWarning;
  return token.colorTextTertiary;
}

function describePayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '—';
  const entries = Object.entries(payload)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length === 0 ? '—' : entries.join(' ');
}

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'en', label: 'English (en)' },
  { value: 'ru', label: 'Русский (ru)' },
  { value: 'de', label: 'Deutsch (de)' },
  { value: 'fr', label: 'Français (fr)' },
  { value: 'es', label: 'Español (es)' },
];
