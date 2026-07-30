'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Breadcrumb, Button, List, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { libraryApi, libraryKeys } from '../../entities/library';
import { useErrorMessage } from '../../shared/lib';

// A mini directory browser over /api/admin/library-path-candidates (docs/11 §11.10): starts at
// LIBRARY_ROOT, drills down, and lets the admin select the folder they are standing in. The server
// only ever lists inside the volume, so there is nothing here to escape with.
export function DirectoryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (path: string) => void;
}) {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const [cwd, setCwd] = useState(value);

  const { data, isPending, error } = useQuery({
    queryKey: libraryKeys.candidates(cwd),
    queryFn: () => libraryApi.pathCandidates(cwd),
    retry: false,
  });

  const segments = cwd === '' ? [] : cwd.split('/');

  return (
    <div>
      <Breadcrumb
        items={[
          { title: <a onClick={() => setCwd('')}>{t('admin.libraries.picker.root')}</a> },
          ...segments.map((segment, index) => ({
            title: <a onClick={() => setCwd(segments.slice(0, index + 1).join('/'))}>{segment}</a>,
          })),
        ]}
      />

      {error !== null && (
        <Alert type="error" showIcon style={{ marginTop: 8 }} message={describeError(error)} />
      )}

      {isPending ? (
        <Spin />
      ) : (
        <List
          size="small"
          bordered
          style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}
          locale={{ emptyText: t('admin.libraries.picker.empty') }}
          dataSource={data?.dirs ?? []}
          renderItem={(dir) => (
            <List.Item>
              <Button
                type="link"
                onClick={() => setCwd(cwd === '' ? dir.name : `${cwd}/${dir.name}`)}
              >
                {dir.name}/
              </Button>
            </List.Item>
          )}
        />
      )}

      <Space style={{ marginTop: 8 }}>
        <Button onClick={() => onChange(cwd)}>{t('admin.libraries.picker.select')}</Button>
        <Typography.Text type="secondary">
          {value === ''
            ? t('admin.libraries.picker.selectedRoot')
            : t('admin.libraries.picker.selected', { path: value })}
        </Typography.Text>
      </Space>
    </div>
  );
}
