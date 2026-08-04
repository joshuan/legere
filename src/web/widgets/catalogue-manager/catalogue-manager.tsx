'use client';

import { useMutation } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Form,
  Modal,
  Popconfirm,
  Space,
  Table,
  type TableColumnType,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { useErrorMessage } from '../../shared/lib';

export type CatalogueColumn<Row> = {
  title: string;
  key: string;
  render: (row: Row) => ReactNode;
  // AntD's own column extras, for the few columns that want them — a filter over the kinds, say.
  filters?: Array<{ text: string; value: string }>;
  // Taken from the table's own column type rather than restated: AntD's filter value is wider than
  // it looks, and a hand-written signature here would only be wrong in a new version.
  onFilter?: TableColumnType<Row>['onFilter'];
};

// The shape every catalogue screen has: a table of rows, one modal that both creates and edits, and
// a delete behind a confirmation that says how far it reaches (docs/11 §11.12). Written once because
// people, subjects and their kinds differ only in their columns and their fields — and a catalogue
// that behaves differently from the catalogue next to it is a catalogue nobody trusts.
export function CatalogueManager<Row extends { id: string }, Values extends object>({
  title,
  createLabel,
  createTitle,
  editTitle,
  emptyText,
  deletedMessage,
  rows,
  loading,
  columns,
  initialValues,
  valuesOf,
  fields,
  confirmDelete,
  onSave,
  onDelete,
  onSaved,
}: {
  title: string;
  createLabel: string;
  createTitle: string;
  editTitle: string;
  emptyText: string;
  deletedMessage: string;
  rows: Row[];
  loading: boolean;
  columns: Array<CatalogueColumn<Row>>;
  initialValues: Values;
  // What the form should hold when this row is opened for editing.
  valuesOf: (row: Row) => Values;
  // The inputs themselves; the row being edited is passed so a field can say it is immutable.
  fields: (editing: Row | null) => ReactNode;
  confirmDelete: (row: Row) => string;
  onSave: (values: Values, editing: Row | null) => Promise<unknown>;
  onDelete: (row: Row) => Promise<unknown>;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();

  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);

  const onError = (error: unknown): void => void message.error(describeError(error));

  const save = useMutation({
    mutationFn: (values: Values) => onSave(values, editing),
    onSuccess: () => {
      setOpen(false);
      setEditing(null);
      form.resetFields();
      onSaved();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (row: Row) => onDelete(row),
    onSuccess: () => {
      void message.success(deletedMessage, 2);
      onSaved();
    },
    onError,
  });

  return (
    <Card
      title={title}
      extra={
        <Button
          type="primary"
          onClick={() => {
            setEditing(null);
            form.resetFields();
            setOpen(true);
          }}
        >
          {createLabel}
        </Button>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText }}
        columns={[
          ...columns.map((column) => ({
            title: column.title,
            key: column.key,
            render: (_: unknown, row: Row) => column.render(row),
            // Both or neither: a filter list with nothing to filter by is a dropdown that does
            // nothing.
            ...(column.filters === undefined || column.onFilter === undefined
              ? {}
              : { filters: column.filters, onFilter: column.onFilter }),
          })),
          {
            title: t('admin.catalogues.columns.actions'),
            key: 'actions',
            render: (_: unknown, row: Row) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    form.setFieldsValue(valuesOf(row));
                    setOpen(true);
                  }}
                >
                  {t('common.actions.edit')}
                </Button>
                <Popconfirm
                  title={confirmDelete(row)}
                  okText={t('common.yes')}
                  cancelText={t('common.actions.cancel')}
                  onConfirm={() => remove.mutate(row)}
                >
                  <Button size="small" danger>
                    {t('common.actions.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing === null ? createTitle : editTitle}
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
          initialValues={initialValues}
          onFinish={(values: Values) => save.mutate(values)}
        >
          {fields(editing)}
        </Form>
      </Modal>
    </Card>
  );
}
