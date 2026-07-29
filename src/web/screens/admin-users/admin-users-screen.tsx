'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type { UserRole } from '../../../shared/contracts/enums';
import type { AdminUserDto, InviteDto } from '../../../shared/contracts/users';
import { userApi, userKeys } from '../../entities/user';
import { useErrorMessage } from '../../shared/lib';
import { OneTimeLinkModal } from '../../shared/ui';

type OneTimeLink = { title: string; url: string; expiresAt: string } | null;

// /admin/users (docs/11 §11.11): the user table with lifecycle actions, invite creation, and the
// active invite list. LAST_ADMIN and other refusals surface as toasts.
export function AdminUsersScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [link, setLink] = useState<OneTimeLink>(null);

  const users = useQuery({ queryKey: userKeys.list, queryFn: () => userApi.list({ limit: 100 }) });
  const invites = useQuery({ queryKey: userKeys.invites, queryFn: userApi.listInvites });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: userKeys.list });
    void queryClient.invalidateQueries({ queryKey: userKeys.invites });
  }, [queryClient]);

  const onError = useCallback(
    (error: unknown) => {
      void message.error(describeError(error));
    },
    [describeError, message],
  );

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => userApi.changeRole(id, role),
    onSuccess: refresh,
    onError,
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      active ? userApi.reactivate(id) : userApi.deactivate(id),
    onSuccess: refresh,
    onError,
  });

  const revokeSessions = useMutation({
    mutationFn: (id: string) => userApi.revokeSessions(id),
    onSuccess: (result) => {
      void message.success(t('admin.users.sessionsRevoked', { count: result.revoked }));
    },
    onError,
  });

  const passwordReset = useMutation({
    mutationFn: (id: string) => userApi.createPasswordReset(id),
    onSuccess: (result) =>
      setLink({
        title: t('admin.users.resetLinkTitle'),
        url: result.url,
        expiresAt: result.expiresAt,
      }),
    onError,
  });

  const createInvite = useMutation({
    mutationFn: (values: { role: UserRole; emailHint?: string }) =>
      userApi.createInvite(
        values.emailHint === undefined || values.emailHint === ''
          ? { role: values.role }
          : { role: values.role, emailHint: values.emailHint },
      ),
    onSuccess: (result) => {
      setInviteOpen(false);
      setLink({
        title: t('admin.invites.linkTitle'),
        url: result.url,
        expiresAt: result.expiresAt,
      });
      refresh();
    },
    onError,
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => userApi.revokeInvite(id),
    onSuccess: refresh,
    onError,
  });

  const userColumns = [
    { title: t('admin.users.columns.name'), dataIndex: 'displayName', key: 'displayName' },
    { title: t('admin.users.columns.email'), dataIndex: 'email', key: 'email' },
    {
      title: t('admin.users.columns.role'),
      key: 'role',
      render: (_: unknown, user: AdminUserDto) => (
        <Tag color={user.role === 'ADMIN' ? 'blue' : 'default'}>{user.role}</Tag>
      ),
    },
    {
      title: t('admin.users.columns.status'),
      key: 'status',
      render: (_: unknown, user: AdminUserDto) =>
        user.deactivatedAt === null ? (
          <Tag color="green">{t('admin.users.status.active')}</Tag>
        ) : (
          <Tag>{t('admin.users.status.deactivated')}</Tag>
        ),
    },
    {
      title: t('admin.users.columns.created'),
      key: 'createdAt',
      render: (_: unknown, user: AdminUserDto) => new Date(user.createdAt).toLocaleDateString(),
    },
    {
      title: t('admin.users.columns.actions'),
      key: 'actions',
      render: (_: unknown, user: AdminUserDto) => (
        <Space size="small">
          {/* Role changes are consequential (the LAST_ADMIN guard exists for a reason), so they
              confirm like the other row actions rather than firing on a stray select (11 §11.14). */}
          <Popconfirm
            title={
              user.role === 'ADMIN'
                ? t('admin.users.confirmDemote', { email: user.email })
                : t('admin.users.confirmPromote', { email: user.email })
            }
            onConfirm={() =>
              changeRole.mutate({ id: user.id, role: user.role === 'ADMIN' ? 'USER' : 'ADMIN' })
            }
          >
            <Button size="small">
              {user.role === 'ADMIN'
                ? t('admin.users.actions.makeUser')
                : t('admin.users.actions.makeAdmin')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={
              user.deactivatedAt === null
                ? t('admin.users.confirmDeactivate', { email: user.email })
                : t('admin.users.confirmReactivate', { email: user.email })
            }
            onConfirm={() => setActive.mutate({ id: user.id, active: user.deactivatedAt !== null })}
          >
            <Button size="small" danger={user.deactivatedAt === null}>
              {user.deactivatedAt === null
                ? t('admin.users.actions.deactivate')
                : t('admin.users.actions.reactivate')}
            </Button>
          </Popconfirm>
          <Button size="small" onClick={() => revokeSessions.mutate(user.id)}>
            {t('admin.users.actions.revokeSessions')}
          </Button>
          <Button size="small" onClick={() => passwordReset.mutate(user.id)}>
            {t('admin.users.actions.resetLink')}
          </Button>
        </Space>
      ),
    },
  ];

  const inviteColumns = [
    { title: t('admin.invites.columns.role'), dataIndex: 'role', key: 'role' },
    { title: t('admin.invites.columns.emailHint'), dataIndex: 'emailHint', key: 'emailHint' },
    {
      title: t('admin.invites.columns.expires'),
      key: 'expiresAt',
      render: (_: unknown, invite: InviteDto) => new Date(invite.expiresAt).toLocaleString(),
    },
    {
      title: t('admin.users.columns.actions'),
      key: 'actions',
      render: (_: unknown, invite: InviteDto) => (
        <Popconfirm
          title={t('admin.invites.confirmRevoke')}
          onConfirm={() => revokeInvite.mutate(invite.id)}
        >
          <Button size="small" danger>
            {t('admin.invites.actions.revoke')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card
        title={t('admin.users.title')}
        extra={
          <Button type="primary" onClick={() => setInviteOpen(true)}>
            {t('admin.invites.actions.create')}
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={users.isPending}
          dataSource={users.data?.items ?? []}
          columns={userColumns}
          pagination={false}
        />
      </Card>

      <Card title={t('admin.invites.title')}>
        <Table
          rowKey="id"
          loading={invites.isPending}
          dataSource={invites.data?.items ?? []}
          columns={inviteColumns}
          pagination={false}
          locale={{ emptyText: t('admin.invites.empty') }}
        />
      </Card>

      <Modal
        open={inviteOpen}
        title={t('admin.invites.actions.create')}
        okText={t('admin.invites.actions.create')}
        onCancel={() => setInviteOpen(false)}
        footer={null}
      >
        <Form
          layout="vertical"
          initialValues={{ role: 'USER' }}
          onFinish={(values: { role: UserRole; emailHint?: string }) => createInvite.mutate(values)}
        >
          <Form.Item label={t('admin.invites.fields.role')} name="role">
            <Select
              aria-label={t('admin.invites.fields.role')}
              options={[
                { value: 'USER', label: 'USER' },
                { value: 'ADMIN', label: 'ADMIN' },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('admin.invites.fields.emailHint')} name="emailHint">
            <input className="ant-input" aria-label={t('admin.invites.fields.emailHint')} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createInvite.isPending} block>
            {t('admin.invites.actions.create')}
          </Button>
        </Form>
      </Modal>

      <OneTimeLinkModal
        open={link !== null}
        title={link?.title ?? ''}
        url={link?.url ?? null}
        expiresAt={link?.expiresAt ?? null}
        onClose={() => setLink(null)}
      />
    </Space>
  );
}
