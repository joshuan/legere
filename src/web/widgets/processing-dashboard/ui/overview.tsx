'use client';

import { Alert, Card, Space, Statistic, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type {
  ProcessingSnapshotResponse,
  ProcessingTopologyDto,
} from '../../../../shared/contracts/processing';
import { formatBytes } from '../../../shared/lib';
import styles from '../processing.module.css';
import { type QueueRow, type QueueTopology } from '../model/types';
import { Timestamp, Blockers } from './settings';
import { QueueControls } from './queue-controls';

export function ControlPlaneState({ snapshot }: { snapshot: ProcessingSnapshotResponse }) {
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

export function OverviewTab({ snapshot }: { snapshot: ProcessingSnapshotResponse }) {
  const t = useTranslations();
  const storage = snapshot.storage;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <TopologyStrip topology={snapshot.topology} />
      <section aria-label={t('admin.queue.stages.title')} className={styles.queueGrid}>
        {snapshot.queues.map((row) => (
          <QueueCard key={row.name} row={row} snapshot={snapshot} />
        ))}
      </section>

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

export function QueueCard({
  row,
  snapshot,
}: {
  row: QueueRow;
  snapshot: ProcessingSnapshotResponse;
}) {
  const t = useTranslations();
  return (
    <Card
      size="small"
      className={styles.queueCard ?? ''}
      role="region"
      aria-label={t(`admin.queue.names.${row.name}`)}
    >
      <div className={styles.cardContent}>
        <QueueIdentity
          row={row}
          topology={snapshot.topology.queues.find((item) => item.name === row.name)}
        />
        <div className={styles.metrics}>
          <Statistic title={t('admin.queue.queued')} value={row.runtime.queued} />
          <Statistic title={t('admin.queue.active')} value={row.runtime.active} />
          <Statistic
            title={t('admin.queue.failedRecent')}
            value={row.runtime.failedRecent}
            valueStyle={{
              color: row.runtime.failedRecent > 0 ? 'var(--ant-color-error)' : 'inherit',
            }}
          />
          <Statistic
            title={t('admin.queue.liveness.completedLastHour')}
            value={row.runtime.completedLastHour}
          />
        </div>
        <div className={styles.timestamps}>
          <div>
            <Typography.Text type="secondary">
              {t('admin.queue.liveness.oldestQueuedAt')}:{' '}
            </Typography.Text>
            <Timestamp
              value={row.runtime.oldestQueuedAt}
              empty={t('admin.queue.liveness.noQueuedWork')}
            />
          </div>
          <div>
            <Typography.Text type="secondary">
              {t('admin.queue.liveness.lastCompletedAt')}:{' '}
            </Typography.Text>
            <Timestamp
              value={row.runtime.lastCompletedAt}
              empty={t('admin.queue.liveness.noRetainedCompletion')}
            />
          </div>
        </div>
        <div className={styles.controls}>
          <Typography.Text strong>{t('admin.queue.settings.concurrency')}</Typography.Text>
          <QueueControls row={row} revision={snapshot.revision} />
        </div>
        {row.blockers.length > 0 && <Blockers blockers={row.blockers} />}
        {row.name === 'receipt-process' && (
          <Link href="/admin/processing/receipts">{t('admin.queue.receiptProcessing.open')}</Link>
        )}
      </div>
    </Card>
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
