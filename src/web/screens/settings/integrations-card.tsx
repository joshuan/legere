'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { IntegrationDto } from '../../../shared/contracts/integrations';
import { integrationApi, integrationKeys } from '../../entities/integration';
import { apiTokenKeys } from '../../entities/api-token';
import { OneTimeLinkModal, QueryError } from '../../shared/ui';
import { useErrorMessage } from '../../shared/lib';

export function IntegrationsCard() {
  const t = useTranslations();
  const cache = useQueryClient();
  const { message } = App.useApp();
  const describe = useErrorMessage();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<IntegrationDto | null>(null);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [createForm] = Form.useForm<{ name: string }>();
  const [tokenForm] = Form.useForm<{ name: string; expiresInDays: number }>();
  const list = useQuery({ queryKey: integrationKeys.all, queryFn: integrationApi.list });
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: integrationKeys.all });
    void cache.invalidateQueries({ queryKey: apiTokenKeys.all });
  };
  const onError = (error: unknown) => {
    void message.error(describe(error));
  };
  const create = useMutation({
    mutationFn: (name: string) => integrationApi.create(name),
    onError,
    onSuccess: (integration) => {
      setCreating(false);
      createForm.resetFields();
      refresh();
      setSelected(integration);
      tokenForm.setFieldsValue({ name: integration.name, expiresInDays: 90 });
    },
  });
  const issue = useMutation({
    mutationFn: (body: { name: string; expiresInDays: number }) => {
      if (selected === null) throw new Error('No integration selected');
      return integrationApi.issue(selected.id, body);
    },
    onError,
    onSuccess: (result) => {
      setSelected(null);
      setIssued({ token: result.token, expiresAt: result.apiToken.expiresAt });
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: integrationApi.revoke, onError, onSuccess: refresh });
  return (
    <>
      <Card
        title={t('integrations.title')}
        extra={<Button onClick={() => setCreating(true)}>{t('integrations.create')}</Button>}
      >
        <Typography.Paragraph type="secondary">
          {t('integrations.description')}
        </Typography.Paragraph>
        <Typography.Paragraph>
          <a href="/api/openapi.json" target="_blank" rel="noreferrer">
            {t('integrations.openapi')}
          </a>
        </Typography.Paragraph>
        {list.isError && <QueryError error={list.error} retry={list.refetch} />}
        <List
          loading={list.isPending}
          dataSource={list.data?.items ?? []}
          locale={{ emptyText: t('integrations.empty') }}
          renderItem={(item) => (
            <List.Item key={item.id}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space wrap>
                  <Typography.Text strong>{item.name}</Typography.Text>
                  <Tag>{t('integrations.documents', { count: item.documentCount })}</Tag>
                  {item.revokedAt !== null && <Tag>{t('settings.apiTokens.statuses.REVOKED')}</Tag>}
                </Space>
                <Typography.Text
                  type="secondary"
                  copyable={{ text: item.id }}
                  style={{ fontSize: 12, overflowWrap: 'anywhere' }}
                >
                  {item.id}
                </Typography.Text>
                {item.revokedAt === null && (
                  <Space wrap>
                    <Button
                      size="small"
                      onClick={() => {
                        setSelected(item);
                        tokenForm.setFieldsValue({ name: item.name, expiresInDays: 90 });
                      }}
                    >
                      {t('integrations.issue')}
                    </Button>
                    <Popconfirm
                      title={t('integrations.revokeConfirm')}
                      onConfirm={() => revoke.mutate(item.id)}
                    >
                      <Button
                        size="small"
                        danger
                        loading={revoke.isPending && revoke.variables === item.id}
                      >
                        {t('integrations.revoke')}
                      </Button>
                    </Popconfirm>
                  </Space>
                )}
              </Space>
            </List.Item>
          )}
        />
      </Card>
      <Modal
        open={creating}
        title={t('integrations.create')}
        onCancel={() => setCreating(false)}
        footer={null}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={(body) => create.mutate(body.name)}>
          <Form.Item
            name="name"
            label={t('integrations.name')}
            rules={[{ required: true, whitespace: true, max: 128 }]}
          >
            <Input autoFocus placeholder="Rent Manage" maxLength={128} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>
            {t('integrations.create')}
          </Button>
        </Form>
      </Modal>
      <Modal
        open={selected !== null}
        title={t('integrations.issueFor', { name: selected?.name ?? '' })}
        onCancel={() => setSelected(null)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">{t('integrations.tokenHelp')}</Typography.Paragraph>
        <Form form={tokenForm} layout="vertical" onFinish={(body) => issue.mutate(body)}>
          <Form.Item
            name="name"
            label={t('settings.apiTokens.name')}
            rules={[{ required: true, whitespace: true, max: 128 }]}
          >
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item
            name="expiresInDays"
            label={t('settings.apiTokens.expiresInDays')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={365} style={{ width: '100%' }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={issue.isPending}>
            {t('integrations.issue')}
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
    </>
  );
}
