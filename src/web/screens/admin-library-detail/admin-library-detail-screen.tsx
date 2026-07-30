'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Descriptions, Space, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ScanRunDto } from '../../../shared/contracts/libraries';
import { libraryApi, libraryKeys } from '../../entities/library';
import { useErrorMessage } from '../../shared/lib';
import { statusColor } from '../admin-libraries';

// While a scan is running the journal refreshes on this interval, so the row updates in place
// (docs/11 §11.10 "a live progress row while a scan runs").
const LIVE_REFRESH_MS = 5000;

// /admin/libraries/:id (docs/11 §11.10): settings plus the scan journal.
export function AdminLibraryDetailScreen({ id }: { id: string }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const library = useQuery({
    queryKey: libraryKeys.detail(id),
    queryFn: () => libraryApi.get(id),
  });

  const scans = useQuery({
    queryKey: libraryKeys.scans(id),
    queryFn: () => libraryApi.scans(id),
    // Polling only while something is actually running — an idle journal is static (docs/10 §10.5).
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((run) => run.status === 'RUNNING')
        ? LIVE_REFRESH_MS
        : false,
  });

  const scanNow = useMutation({
    mutationFn: () => libraryApi.scan(id),
    onSuccess: (result) => {
      void message.success(
        'alreadyRunning' in result
          ? t('admin.libraries.scanAlreadyRunning')
          : t('admin.libraries.scanStarted'),
        2,
      );
      void queryClient.invalidateQueries({ queryKey: libraryKeys.scans(id) });
    },
    onError: (error: unknown) => {
      void message.error(describeError(error));
    },
  });

  const columns = [
    {
      title: t('admin.libraries.scans.started'),
      key: 'startedAt',
      render: (_: unknown, run: ScanRunDto) => new Date(run.startedAt).toLocaleString(),
    },
    {
      title: t('admin.libraries.scans.duration'),
      key: 'duration',
      render: (_: unknown, run: ScanRunDto) =>
        run.finishedAt === null
          ? t('admin.libraries.scans.inProgress')
          : t('admin.libraries.scans.seconds', {
              seconds: Math.max(
                0,
                Math.round(
                  (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000,
                ),
              ),
            }),
    },
    {
      title: t('admin.libraries.scans.status'),
      key: 'status',
      render: (_: unknown, run: ScanRunDto) => (
        <Tag color={statusColor(run.status)}>{run.status}</Tag>
      ),
    },
    {
      title: t('admin.libraries.scans.counters'),
      key: 'counters',
      render: (_: unknown, run: ScanRunDto) =>
        t('admin.libraries.scans.countersValue', {
          seen: run.filesSeen,
          new: run.filesNew,
          changed: run.filesChanged,
          missing: run.filesMissing,
        }),
    },
    {
      title: t('admin.libraries.scans.error'),
      key: 'error',
      render: (_: unknown, run: ScanRunDto) =>
        run.error === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Typography.Text type="danger">{run.error}</Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title={library.data?.name ?? t('common.loading')}
        loading={library.isPending}
        extra={
          <Space>
            <Link href="/admin/libraries">{t('admin.libraries.backToList')}</Link>
            <Button type="primary" onClick={() => scanNow.mutate()} loading={scanNow.isPending}>
              {t('admin.libraries.actions.scanNow')}
            </Button>
          </Space>
        }
      >
        {library.data !== undefined && (
          <Descriptions column={1} size="small">
            <Descriptions.Item label={t('admin.libraries.fields.rootPath')}>
              <Typography.Text code>
                {library.data.rootPath === '' ? '/' : library.data.rootPath}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label={t('admin.libraries.fields.enabled')}>
              {library.data.enabled ? t('common.yes') : t('common.no')}
            </Descriptions.Item>
            <Descriptions.Item label={t('admin.libraries.fields.visibility')}>
              {t(`admin.libraries.visibility.${library.data.visibility}`)}
            </Descriptions.Item>
            <Descriptions.Item label={t('admin.libraries.fields.scanInterval')}>
              {t('admin.libraries.minutes', { minutes: library.data.scanIntervalMinutes })}
            </Descriptions.Item>
            <Descriptions.Item label={t('admin.libraries.fields.excludeGlobs')}>
              {library.data.excludeGlobs.length === 0
                ? '—'
                : library.data.excludeGlobs.map((glob) => <Tag key={glob}>{glob}</Tag>)}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title={t('admin.libraries.scans.title')}>
        <Table
          rowKey="id"
          loading={scans.isPending}
          dataSource={scans.data?.items ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: t('admin.libraries.scans.empty') }}
        />
      </Card>
    </Space>
  );
}
