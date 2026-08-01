'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, Empty, List, Space, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ScanSetDto } from '../../../shared/contracts/scan-sets';
import { scanSetApi, scanSetKeys } from '../../entities/scan-set';

// A set that is still working refreshes on its own, the way the rest of the product does.
const LIVE_REFRESH_MS = 5000;

// /scan-sets (docs/11 §11.8).
export function ScanSetsScreen() {
  const t = useTranslations();

  const scanSets = useQuery({
    queryKey: scanSetKeys.all,
    queryFn: scanSetApi.list,
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((item) => isWorking(item)) ? LIVE_REFRESH_MS : false,
  });

  return (
    <Card title={t('scanSets.title')} loading={scanSets.isPending}>
      {(scanSets.data?.items ?? []).length === 0 ? (
        <Empty description={t('scanSets.empty')} />
      ) : (
        <List
          dataSource={scanSets.data?.items ?? []}
          renderItem={(scanSet) => (
            <List.Item
              actions={
                scanSet.resultDocumentId === null
                  ? []
                  : [
                      <Link key="result" href={`/documents/${scanSet.resultDocumentId}`}>
                        {t('scanSets.openResult')}
                      </Link>,
                    ]
              }
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Link href={`/scan-sets/${scanSet.id}`}>{scanSet.name}</Link>
                    <Tag color={statusColor(scanSet.status)}>{scanSet.status}</Tag>
                  </Space>
                }
                description={
                  <Space size="small">
                    <Typography.Text type="secondary">
                      {t('scanSets.pageCount', { count: scanSet.itemCount })}
                    </Typography.Text>
                    {scanSet.error !== null && (
                      <Typography.Text type="danger">{scanSet.error}</Typography.Text>
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

function isWorking(scanSet: ScanSetDto): boolean {
  return scanSet.status === 'QUEUED' || scanSet.status === 'PROCESSING';
}

export function statusColor(status: ScanSetDto['status']): string {
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'PROCESSING' || status === 'QUEUED') return 'blue';
  return 'default';
}
