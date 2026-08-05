'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type { DocumentTypeDto } from '../../../shared/contracts/document-types';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { useErrorMessage } from '../../shared/lib';

type FormValues = {
  slug: string;
  name: string;
  description: string;
};

// /document-types (docs/11 §11.12): the reference list the classifier chooses from and the
// filters are built on.
export function DocumentTypesScreen({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();

  const [editing, setEditing] = useState<DocumentTypeDto | null>(null);
  const [open, setOpen] = useState(false);

  const documentTypes = useQuery({ queryKey: documentTypeKeys.all, queryFn: documentTypeApi.list });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: documentTypeKeys.all });
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
        ? documentTypeApi.create({ slug: values.slug, name: values.name, description })
        : documentTypeApi.update(editing.id, { name: values.name, description });
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
    mutationFn: (id: string) => documentTypeApi.remove(id),
    onSuccess: () => {
      void message.success(t('admin.documentTypes.deleted'), 2);
      refresh();
    },
    onError,
  });

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (documentType: DocumentTypeDto): void => {
    setEditing(documentType);
    form.setFieldsValue({
      slug: documentType.slug,
      name: documentType.name,
      description: documentType.description ?? '',
    });
    setOpen(true);
  };

  // Reading the reference list is everybody's — a filter is built on it, and a document wears its
  // type. Defining one is an admin's, exactly as the API has it (docs/07 §7.3).
  const columns = [
    {
      title: t('admin.documentTypes.columns.slug'),
      key: 'slug',
      render: (_: unknown, documentType: DocumentTypeDto) => (
        <Typography.Text code>{documentType.slug}</Typography.Text>
      ),
    },
    {
      title: t('admin.documentTypes.columns.name'),
      key: 'name',
      render: (_: unknown, documentType: DocumentTypeDto) => documentType.name,
    },
    {
      title: t('admin.documentTypes.columns.description'),
      key: 'description',
      render: (_: unknown, documentType: DocumentTypeDto) =>
        documentType.description ?? <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: t('admin.documentTypes.columns.documents'),
      key: 'documents',
      render: (_: unknown, documentType: DocumentTypeDto) => documentType.documentCount,
    },
    ...(!isAdmin
      ? []
      : [
          {
            title: t('admin.documentTypes.columns.actions'),
            key: 'actions',
            render: (_: unknown, documentType: DocumentTypeDto) => (
              <Space>
                <Button size="small" onClick={() => openEdit(documentType)}>
                  {t('common.actions.edit')}
                </Button>
                <Popconfirm
                  title={t('admin.documentTypes.confirmDelete', {
                    name: documentType.name,
                    count: documentType.documentCount,
                  })}
                  okText={t('common.yes')}
                  cancelText={t('common.actions.cancel')}
                  onConfirm={() => remove.mutate(documentType.id)}
                >
                  <Button size="small" danger>
                    {t('common.actions.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]),
  ];

  return (
    <Card
      title={t('admin.documentTypes.title')}
      extra={
        isAdmin ? (
          <Button type="primary" onClick={openCreate}>
            {t('admin.documentTypes.actions.create')}
          </Button>
        ) : null
      }
    >
      <Table
        rowKey="id"
        loading={documentTypes.isPending}
        dataSource={documentTypes.data?.items ?? []}
        columns={columns}
        pagination={false}
        locale={{ emptyText: t('admin.documentTypes.empty') }}
      />

      <Modal
        open={open}
        title={
          editing === null
            ? t('admin.documentTypes.createTitle')
            : t('admin.documentTypes.editTitle')
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
            label={t('admin.documentTypes.fields.slug')}
            rules={[
              { required: true, message: t('admin.documentTypes.fields.slugRequired') },
              {
                pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
                message: t('admin.documentTypes.fields.slugFormat'),
              },
            ]}
            // 🔒 Immutable after creation: documents, the classifier and bookmarked filters all
            // refer to it (docs/07 §7.3).
            extra={editing === null ? undefined : t('admin.documentTypes.fields.slugImmutable')}
          >
            <Input disabled={editing !== null} placeholder="invoice" />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('admin.documentTypes.fields.name')}
            rules={[{ required: true, message: t('admin.documentTypes.fields.nameRequired') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="description"
            label={t('admin.documentTypes.fields.description')}
            extra={t('admin.documentTypes.fields.descriptionHint')}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
