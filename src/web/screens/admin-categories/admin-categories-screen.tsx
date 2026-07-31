'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type { CategoryDto } from '../../../shared/contracts/categories';
import { categoryApi, categoryKeys } from '../../entities/category';
import { useErrorMessage } from '../../shared/lib';

type FormValues = {
  slug: string;
  name: string;
  description: string;
};

// /admin/categories (docs/11 §11.12): the reference list the classifier chooses from and the
// filters are built on.
export function AdminCategoriesScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();

  const [editing, setEditing] = useState<CategoryDto | null>(null);
  const [open, setOpen] = useState(false);

  const categories = useQuery({ queryKey: categoryKeys.all, queryFn: categoryApi.list });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: categoryKeys.all });
  }, [queryClient]);

  const onError = useCallback(
    (error: unknown) => {
      void message.error(describeError(error));
    },
    [describeError, message],
  );

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const description = values.description.trim() === '' ? null : values.description.trim();
      return editing === null
        ? categoryApi.create({ slug: values.slug, name: values.name, description })
        : categoryApi.update(editing.id, { name: values.name, description });
    },
    onSuccess: () => {
      setOpen(false);
      setEditing(null);
      form.resetFields();
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => categoryApi.remove(id),
    onSuccess: () => {
      void message.success(t('admin.categories.deleted'), 2);
      refresh();
    },
    onError,
  });

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (category: CategoryDto): void => {
    setEditing(category);
    form.setFieldsValue({
      slug: category.slug,
      name: category.name,
      description: category.description ?? '',
    });
    setOpen(true);
  };

  const columns = [
    {
      title: t('admin.categories.columns.slug'),
      key: 'slug',
      render: (_: unknown, category: CategoryDto) => (
        <Typography.Text code>{category.slug}</Typography.Text>
      ),
    },
    {
      title: t('admin.categories.columns.name'),
      key: 'name',
      render: (_: unknown, category: CategoryDto) => category.name,
    },
    {
      title: t('admin.categories.columns.description'),
      key: 'description',
      render: (_: unknown, category: CategoryDto) =>
        category.description ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('admin.categories.columns.documents'),
      key: 'documents',
      render: (_: unknown, category: CategoryDto) => category.documentCount,
    },
    {
      title: t('admin.categories.columns.actions'),
      key: 'actions',
      render: (_: unknown, category: CategoryDto) => (
        <Space>
          <Button size="small" onClick={() => openEdit(category)}>
            {t('common.actions.edit')}
          </Button>
          <Popconfirm
            title={t('admin.categories.confirmDelete', {
              name: category.name,
              count: category.documentCount,
            })}
            okText={t('common.yes')}
            cancelText={t('common.actions.cancel')}
            onConfirm={() => remove.mutate(category.id)}
          >
            <Button size="small" danger>
              {t('common.actions.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('admin.categories.title')}
      extra={
        <Button type="primary" onClick={openCreate}>
          {t('admin.categories.actions.create')}
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={categories.isPending}
        dataSource={categories.data?.items ?? []}
        columns={columns}
        pagination={false}
        locale={{ emptyText: t('admin.categories.empty') }}
      />

      <Modal
        open={open}
        title={
          editing === null ? t('admin.categories.createTitle') : t('admin.categories.editTitle')
        }
        okText={t('common.actions.save')}
        cancelText={t('common.actions.cancel')}
        confirmLoading={save.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => void form.submit()}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ slug: '', name: '', description: '' }}
          onFinish={(values) => save.mutate(values)}
        >
          <Form.Item
            name="slug"
            label={t('admin.categories.fields.slug')}
            rules={[
              { required: true, message: t('admin.categories.fields.slugRequired') },
              {
                pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
                message: t('admin.categories.fields.slugFormat'),
              },
            ]}
            // 🔒 Immutable after creation: documents, the classifier and bookmarked filters all
            // refer to it (docs/07 §7.3).
            extra={editing === null ? undefined : t('admin.categories.fields.slugImmutable')}
          >
            <Input disabled={editing !== null} placeholder="invoice" />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('admin.categories.fields.name')}
            rules={[{ required: true, message: t('admin.categories.fields.nameRequired') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="description"
            label={t('admin.categories.fields.description')}
            extra={t('admin.categories.fields.descriptionHint')}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
