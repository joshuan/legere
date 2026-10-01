'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { oauthApi, oauthKeys } from '../../entities/oauth';
import { QueryError } from '../../shared/ui';
import { useErrorMessage } from '../../shared/lib';

const subscribeToOrigin = () => () => undefined;
const originSnapshot = () => `${window.location.origin}/api/mcp`;
const serverOriginSnapshot = () => '/api/mcp';

export function OAuthGrantsCard() {
  const t = useTranslations();
  const endpoint = useSyncExternalStore(subscribeToOrigin, originSnapshot, serverOriginSnapshot);
  const cache = useQueryClient();
  const describe = useErrorMessage();
  const { message } = App.useApp();
  const grants = useQuery({ queryKey: oauthKeys.grants, queryFn: oauthApi.list });
  const revoke = useMutation({
    mutationFn: oauthApi.revoke,
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: oauthKeys.grants });
    },
    onError: (error: unknown) => {
      void message.error(describe(error));
    },
  });
  return (
    <Card title={t('oauth.connections')}>
      <Typography.Paragraph type="secondary">{t('oauth.connectionHelp')}</Typography.Paragraph>
      <Typography.Paragraph code copyable>
        {endpoint}
      </Typography.Paragraph>
      {grants.isError && <QueryError error={grants.error} retry={grants.refetch} />}
      <List
        loading={grants.isPending}
        dataSource={grants.data?.items ?? []}
        locale={{ emptyText: t('oauth.empty') }}
        renderItem={(grant) => {
          const status =
            grant.revokedAt !== null
              ? 'REVOKED'
              : new Date(grant.expiresAt).getTime() <= Date.now()
                ? 'EXPIRED'
                : 'ACTIVE';
          return (
            <List.Item key={grant.id}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space wrap>
                  <Typography.Text strong>{grant.clientName}</Typography.Text>
                  <Tag>{t(`settings.apiTokens.statuses.${status}`)}</Tag>
                </Space>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, overflowWrap: 'anywhere' }}
                >
                  {t('oauth.clientId')}: {grant.clientId}
                </Typography.Text>
                <Typography.Text type="secondary">{t('oauth.readScope')}</Typography.Text>
                {status === 'ACTIVE' && (
                  <Popconfirm
                    title={t('oauth.revokeConfirm')}
                    onConfirm={() => revoke.mutate(grant.id)}
                  >
                    <Button
                      size="small"
                      danger
                      loading={revoke.isPending && revoke.variables === grant.id}
                    >
                      {t('oauth.revoke')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            </List.Item>
          );
        }}
      />
    </Card>
  );
}
