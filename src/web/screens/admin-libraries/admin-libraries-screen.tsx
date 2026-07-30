'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { LibraryAdminDto, LibraryAdminListItem } from '../../../shared/contracts/libraries';
import { libraryApi, libraryKeys } from '../../entities/library';
import { LibraryDrawer } from '../../features/library-form';
import { useErrorMessage } from '../../shared/lib';

// /admin/libraries (docs/11 §11.10): the table with counters, the enabled switch, Scan-now, and the
// create/edit drawer. This is the screen the primary product scenario runs through.
export function AdminLibrariesScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<LibraryAdminDto | null>(null);

  const libraries = useQuery({ queryKey: libraryKeys.admin, queryFn: libraryApi.listAdmin });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: libraryKeys.admin });
  }, [queryClient]);

  const onError = useCallback(
    (error: unknown) => {
      void message.error(describeError(error));
    },
    [describeError, message],
  );

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      libraryApi.update(id, { enabled }),
    onSuccess: refresh,
    onError,
  });

  const scanNow = useMutation({
    mutationFn: (id: string) => libraryApi.scan(id),
    onSuccess: (result) => {
      // A scan already in flight is not an error — it is the honest answer (docs/05 §5.2).
      void message.success(
        'alreadyRunning' in result
          ? t('admin.libraries.scanAlreadyRunning')
          : t('admin.libraries.scanStarted'),
        2,
      );
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => libraryApi.remove(id),
    onSuccess: refresh,
    onError,
  });

  const columns = [
    {
      title: t('admin.libraries.columns.name'),
      key: 'name',
      render: (_: unknown, library: LibraryAdminListItem) => (
        <Link href={`/admin/libraries/${library.id}`}>{library.name}</Link>
      ),
    },
    {
      title: t('admin.libraries.columns.path'),
      key: 'rootPath',
      render: (_: unknown, library: LibraryAdminListItem) => (
        <Typography.Text code>{library.rootPath === '' ? '/' : library.rootPath}</Typography.Text>
      ),
    },
    {
      title: t('admin.libraries.columns.enabled'),
      key: 'enabled',
      render: (_: unknown, library: LibraryAdminListItem) => (
        <Switch
          size="small"
          checked={library.enabled}
          aria-label={t('admin.libraries.columns.enabled')}
          onChange={(enabled) => toggleEnabled.mutate({ id: library.id, enabled })}
        />
      ),
    },
    {
      title: t('admin.libraries.columns.visibility'),
      key: 'visibility',
      render: (_: unknown, library: LibraryAdminListItem) => (
        <Tag color={library.visibility === 'ALL_USERS' ? 'green' : 'default'}>
          {t(`admin.libraries.visibility.${library.visibility}`)}
        </Tag>
      ),
    },
    {
      title: t('admin.libraries.columns.counters'),
      key: 'counters',
      render: (_: unknown, library: LibraryAdminListItem) =>
        t('admin.libraries.countersValue', {
          files: library.counters.files,
          documents: library.counters.documents,
          missing: library.counters.missing,
        }),
    },
    {
      title: t('admin.libraries.columns.lastScan'),
      key: 'lastScan',
      render: (_: unknown, library: LibraryAdminListItem) =>
        library.lastScan === null ? (
          <Typography.Text type="secondary">{t('admin.libraries.neverScanned')}</Typography.Text>
        ) : (
          <Space size="small">
            <Tag color={statusColor(library.lastScan.status)}>{library.lastScan.status}</Tag>
            <Typography.Text type="secondary">
              {new Date(library.lastScan.startedAt).toLocaleString()}
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: t('admin.libraries.columns.actions'),
      key: 'actions',
      render: (_: unknown, library: LibraryAdminListItem) => (
        <Space size="small">
          <Button size="small" onClick={() => scanNow.mutate(library.id)}>
            {t('admin.libraries.actions.scanNow')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              setEditing(library);
              setDrawerOpen(true);
            }}
          >
            {t('admin.libraries.actions.edit')}
          </Button>
          <Popconfirm
            title={t('admin.libraries.confirmDelete', { name: library.name })}
            onConfirm={() => remove.mutate(library.id)}
          >
            <Button size="small" danger>
              {t('admin.libraries.actions.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card
        title={t('admin.libraries.title')}
        extra={
          <Button
            type="primary"
            onClick={() => {
              setEditing(null);
              setDrawerOpen(true);
            }}
          >
            {t('admin.libraries.actions.create')}
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={libraries.isPending}
          dataSource={libraries.data?.items ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: t('admin.libraries.empty') }}
        />
      </Card>

      <LibraryDrawer
        open={drawerOpen}
        library={editing}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
      />
    </>
  );
}

export function statusColor(status: 'RUNNING' | 'DONE' | 'FAILED'): string {
  if (status === 'RUNNING') return 'processing';
  return status === 'DONE' ? 'green' : 'red';
}
