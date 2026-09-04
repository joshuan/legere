'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Empty, Form, Input, List, Modal, Space, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { CollectionDto } from '../../../shared/contracts/collections';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { useErrorMessage } from '../../shared/lib';

type FormValues = { name: string; description: string };

// /collections (docs/11 §11.7): what I made, and what was shared with me.
export function CollectionsScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [open, setOpen] = useState(false);

  const collections = useQuery({ queryKey: collectionKeys.all, queryFn: collectionApi.list });

  const create = useMutation({
    mutationFn: (values: FormValues) =>
      collectionApi.create({
        name: values.name,
        description: values.description.trim() === '' ? null : values.description.trim(),
      }),
    onSuccess: () => {
      setOpen(false);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: collectionKeys.all });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const items = collections.data?.items ?? [];
  const mine = items.filter((item) => item.mine);
  const shared = items.filter((item) => !item.mine);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('collections.title')}
        </Typography.Title>
        <Button type="primary" onClick={() => setOpen(true)}>
          {t('collections.actions.create')}
        </Button>
      </Space>

      <Card title={t('collections.mine')} loading={collections.isPending}>
        <Group items={mine} empty={t('collections.emptyMine')} />
      </Card>

      <Card title={t('collections.sharedWithMe')} loading={collections.isPending}>
        <Group items={shared} empty={t('collections.emptyShared')} showOwner />
      </Card>

      <Modal
        open={open}
        title={t('collections.actions.create')}
        okText={t('common.actions.save')}
        cancelText={t('common.actions.cancel')}
        confirmLoading={create.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => void form.submit()}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ name: '', description: '' }}
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item
            name="name"
            label={t('collections.fields.name')}
            rules={[{ required: true, message: t('collections.fields.nameRequired') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('collections.fields.description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function Group({
  items,
  empty,
  showOwner = false,
}: {
  items: CollectionDto[];
  empty: string;
  showOwner?: boolean;
}) {
  const t = useTranslations();

  if (items.length === 0) return <Empty description={empty} />;

  return (
    <List
      dataSource={items}
      renderItem={(collection) => (
        <List.Item
          actions={[
            <Typography.Text key="count" type="secondary">
              {t('collections.itemCount', { count: collection.itemCount })}
            </Typography.Text>,
          ]}
        >
          <List.Item.Meta
            title={
              <Space>
                <Link href={`/collections/${collection.id}`}>{collection.name}</Link>
                {collection.sharedByMe && <Tag color="blue">{t('collections.sharedByMe')}</Tag>}
                {showOwner && <Tag>{collection.ownerName}</Tag>}
              </Space>
            }
            description={collection.description}
          />
        </List.Item>
      )}
    />
  );
}
