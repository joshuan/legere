'use client';

import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  InputNumber,
  Select,
  Space,
  Statistic,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { ResponsiveTable as Table } from '../../../shared/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { stepStatusSchema } from '../../../../shared/contracts/enums';
import type {
  ProcessingSnapshotResponse,
  ResolvedNumberSettingDto,
} from '../../../../shared/contracts/processing';
import {
  QUEUE_CONCURRENCY_MAX,
  type ReprocessByStepRequest,
  type VectorCounts,
} from '../../../../shared/contracts/queue';
import { processingApi, processingKeys } from '../../../entities/processing';
import { useErrorMessage } from '../../../shared/lib';
import { type NumberDraft } from './queue-controls';
import { ResolvedSetting, statusColor, ResolvedBooleanSetting, Blockers } from './settings';
import { type PipelineRow, type StepTopology, type ServiceRow } from '../model/types';

export function PipelineSettings({
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
              style={{ width: 220, maxWidth: '100%' }}
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

export function PipelineTable({
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

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'en', label: 'English (en)' },
  { value: 'ru', label: 'Русский (ru)' },
  { value: 'de', label: 'Deutsch (de)' },
  { value: 'fr', label: 'Français (fr)' },
  { value: 'es', label: 'Español (es)' },
];
