'use client';

import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, InputNumber, Space, Tag, Tooltip, Typography } from 'antd';
import { ResponsiveTable as Table } from '../../../shared/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ProcessingSnapshotResponse } from '../../../../shared/contracts/processing';
import {
  QUEUE_CONCURRENCY_MAX,
  SERVICE_COOLDOWN_MAX_SECONDS,
  type ServiceHealthStatus,
} from '../../../../shared/contracts/queue';
import { processingApi, processingKeys } from '../../../entities/processing';
import { useErrorMessage } from '../../../shared/lib';
import { type ServiceRow, type ServiceTopology, type ServiceHealth } from '../model/types';
import { ResolvedSetting } from './settings';

export function ServicesTab({
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
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
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
    <Space orientation="vertical" size={0}>
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
    <Space orientation="vertical" size={5}>
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

function GateState({ row }: { row: ServiceRow }) {
  const t = useTranslations();
  const gate = row.gate;
  if (!gate.gated && gate.throttledUntil === null) {
    return <Typography.Text type="secondary">{t('admin.queue.services.ungated')}</Typography.Text>;
  }
  return (
    <Space orientation="vertical" size={0}>
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
    <Space orientation="vertical" size={2}>
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
    <Space orientation="vertical" size={0}>
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
