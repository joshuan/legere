'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { SessionDto } from '../../../shared/contracts/users';
import { sessionApi, sessionKeys } from '../../entities/session';
import { endSession, useErrorMessage } from '../../shared/lib';

// The sessions card on /settings (docs/11 §11.9, docs/08 §8.2). The same power an admin already has
// over somebody's sessions, in the hands of the person those sessions belong to: a credential you
// cannot see is a credential you cannot revoke.
export function SessionsCard() {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const sessions = useQuery({ queryKey: sessionKeys.sessions, queryFn: sessionApi.listSessions });

  const revoke = useMutation({
    mutationFn: (session: SessionDto) => sessionApi.revokeSession(session.id),
    onSuccess: (_result, session) => {
      // Ending this browser's own session leaves it holding nothing; the server already cleared the
      // cookie, so a refresh lands on the login screen rather than on a page that 401s piecemeal.
      // 🔒 The cache goes with it, on the same terms as Sign out — one helper, so the two exits
      // cannot drift apart again (docs/10 §10.5, SEC-68).
      if (session.current) {
        endSession(queryClient, router);
        return;
      }
      void message.success(t('settings.sessions.revoked'), 2);
      void queryClient.invalidateQueries({ queryKey: sessionKeys.sessions });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    <Card title={t('settings.sessions.title')}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('settings.sessions.description')}</Typography.Text>

        <Table<SessionDto>
          rowKey="id"
          size="small"
          loading={sessions.isPending}
          dataSource={sessions.data?.items ?? []}
          pagination={false}
          locale={{ emptyText: t('settings.sessions.empty') }}
          columns={[
            {
              title: t('settings.sessions.columns.device'),
              dataIndex: 'userAgent',
              render: (userAgent: string | null, session: SessionDto) => (
                <Space size="small">
                  <span>{userAgent ?? t('settings.sessions.unknownDevice')}</span>
                  {session.current ? (
                    <Tag color="green">{t('settings.sessions.current')}</Tag>
                  ) : null}
                </Space>
              ),
            },
            {
              title: t('settings.sessions.columns.started'),
              dataIndex: 'createdAt',
              render: (value: string) => new Date(value).toLocaleString(),
            },
            {
              title: t('settings.sessions.columns.expires'),
              dataIndex: 'expiresAt',
              render: (value: string) => new Date(value).toLocaleDateString(),
            },
            {
              title: '',
              key: 'actions',
              render: (_: unknown, session: SessionDto) => (
                <Popconfirm
                  title={
                    session.current
                      ? t('settings.sessions.revokeCurrentConfirm')
                      : t('settings.sessions.revokeConfirm')
                  }
                  okText={t('settings.sessions.revoke')}
                  cancelText={t('common.actions.cancel')}
                  onConfirm={() => revoke.mutate(session)}
                >
                  <Button size="small" danger>
                    {t('settings.sessions.revoke')}
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Space>
    </Card>
  );
}
