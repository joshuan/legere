'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ApiTokenDto, CreateApiTokenRequest } from '../../../shared/contracts/users';
import { apiTokenApi, apiTokenKeys } from '../../entities/api-token';
import { useErrorMessage } from '../../shared/lib';
import { OneTimeLinkModal } from '../../shared/ui';

// The API tokens card on /settings (docs/11 §11.9). A token reads this instance from outside and
// can never write to it, which is the one thing the card has to make obvious.
export function ApiTokensCard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const [creating, setCreating] = useState(false);
  // The plaintext lives here for as long as the modal is open and nowhere else (docs/08 §8.2a).
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [form] = Form.useForm<CreateApiTokenRequest>();

  const tokens = useQuery({ queryKey: apiTokenKeys.all, queryFn: apiTokenApi.list });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: apiTokenKeys.all });
  };

  const create = useMutation({
    mutationFn: (body: CreateApiTokenRequest) => apiTokenApi.create(body),
    onSuccess: (created) => {
      setCreating(false);
      form.resetFields();
      setIssued({ token: created.token, expiresAt: created.apiToken.expiresAt });
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => apiTokenApi.revoke(id),
    onSuccess: () => {
      void message.success(t('settings.apiTokens.revoked'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    <Card
      title={t('settings.apiTokens.title')}
      extra={
        <Button type="primary" onClick={() => setCreating(true)}>
          {t('settings.apiTokens.create')}
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('settings.apiTokens.description')}</Typography.Text>

        <Table<ApiTokenDto>
          rowKey="id"
          size="small"
          loading={tokens.isPending}
          dataSource={tokens.data?.items ?? []}
          pagination={false}
          locale={{ emptyText: t('settings.apiTokens.empty') }}
          columns={[
            { title: t('settings.apiTokens.columns.name'), dataIndex: 'name' },
            {
              title: t('settings.apiTokens.columns.status'),
              dataIndex: 'status',
              render: (status: ApiTokenDto['status']) => (
                <Tag color={statusColor(status)}>{t(`settings.apiTokens.statuses.${status}`)}</Tag>
              ),
            },
            {
              title: t('settings.apiTokens.columns.created'),
              dataIndex: 'createdAt',
              render: (value: string) => new Date(value).toLocaleDateString(),
            },
            {
              title: t('settings.apiTokens.columns.expires'),
              dataIndex: 'expiresAt',
              render: (value: string) => new Date(value).toLocaleDateString(),
            },
            {
              title: t('settings.apiTokens.columns.lastUsed'),
              dataIndex: 'lastUsedAt',
              render: (value: string | null) =>
                value === null ? t('settings.apiTokens.never') : new Date(value).toLocaleString(),
            },
            {
              title: '',
              key: 'actions',
              render: (_: unknown, token: ApiTokenDto) =>
                // A dead token has nothing left to revoke; the row stays as a record of it.
                token.status === 'ACTIVE' ? (
                  <Popconfirm
                    title={t('settings.apiTokens.revokeConfirm')}
                    okText={t('settings.apiTokens.revoke')}
                    cancelText={t('common.actions.cancel')}
                    onConfirm={() => revoke.mutate(token.id)}
                  >
                    <Button size="small" danger>
                      {t('settings.apiTokens.revoke')}
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
        />
      </Space>

      <Modal
        open={creating}
        title={t('settings.apiTokens.create')}
        onCancel={() => setCreating(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: CreateApiTokenRequest) => create.mutate(values)}
        >
          <Form.Item
            label={t('settings.apiTokens.name')}
            name="name"
            rules={[{ required: true, message: t('settings.apiTokens.nameRequired') }]}
          >
            <Input placeholder={t('settings.apiTokens.namePlaceholder')} />
          </Form.Item>
          {/* Left empty on purpose: the instance default is the server's to know (docs/12 §12.4). */}
          <Form.Item label={t('settings.apiTokens.expiresInDays')} name="expiresInDays">
            <InputNumber
              min={1}
              max={365}
              style={{ width: '100%' }}
              placeholder={t('settings.apiTokens.expiresInDaysPlaceholder')}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>
            {t('settings.apiTokens.submit')}
          </Button>
        </Form>
      </Modal>

      <OneTimeLinkModal
        open={issued !== null}
        title={t('settings.apiTokens.issuedTitle')}
        url={issued?.token ?? null}
        expiresAt={issued?.expiresAt ?? null}
        labels={{
          warning: t('settings.apiTokens.issuedWarning'),
          copy: t('settings.apiTokens.issuedCopy'),
        }}
        onClose={() => setIssued(null)}
      />
    </Card>
  );
}

function statusColor(status: ApiTokenDto['status']): string {
  if (status === 'ACTIVE') return 'green';
  return status === 'REVOKED' ? 'red' : 'default';
}
