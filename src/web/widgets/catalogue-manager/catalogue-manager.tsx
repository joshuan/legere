'use client';

import { useMutation } from '@tanstack/react-query';
import {
  App,
  AutoComplete,
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
// What a merge always asks for, whatever is being merged: which of these is the right name. Any
// extra half — a subject's kind — is added by the screen (docs/11 §11.12a).
// Every field a merge asks about is a name or an id, so one string map covers them; a screen that
// needs more shape than that is a screen with a form of its own.
export type MergeValues = Record<string, string>;

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
  canManage,
  canCreate,
  merge,
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
  // Reading a catalogue is everybody's; correcting one reaches across every document that names the
  // row, so it is an admin's (docs/03 §3.3.19–20a). The affordances are simply not offered rather
  // than the screen being hidden: a person who cannot rename a thing still needs to see the list.
  canManage: boolean;
  // Adding is open on the catalogues the analysis writes into, and an admin's on the document types.
  canCreate: boolean;
  // Merging is optional: a catalogue that cannot have duplicates does not need it.
  merge?: {
    // The names on offer as the survivor's, in the order the rows were listed.
    label: (row: Row) => string;
    // Whatever else the merged row needs decided — the kind, for subjects.
    fields?: (rows: Row[]) => ReactNode;
    initialValues?: (rows: Row[]) => MergeValues;
    onMerge: (rows: Row[], values: MergeValues) => Promise<unknown>;
  };
}) {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();

  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeForm] = Form.useForm<MergeValues>();

  const chosen = rows.filter((row) => selected.includes(row.id));

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

  const mergeRows = useMutation({
    mutationFn: (values: MergeValues) =>
      merge === undefined ? Promise.resolve() : merge.onMerge(chosen, values),
    onSuccess: () => {
      setMerging(false);
      setSelected([]);
      mergeForm.resetFields();
      void message.success(t('admin.catalogues.merged'), 2);
      onSaved();
    },
    onError,
  });

  const actionsColumn = {
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
  };

  return (
    <Card
      title={title}
      extra={
        <Space>
          {/* Only once there is something to fold together: a merge of one row is not a merge. */}
          {canManage && merge !== undefined && selected.length > 1 && (
            <Button
              onClick={() => {
                mergeForm.resetFields();
                const first = chosen[0];
                mergeForm.setFieldsValue(
                  merge.initialValues?.(chosen) ??
                    (first === undefined ? {} : { name: merge.label(first) }),
                );
                setMerging(true);
              }}
            >
              {t('admin.catalogues.actions.merge', { count: selected.length })}
            </Button>
          )}
          {canCreate && (
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
          )}
        </Space>
      }
    >
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText }}
        {...(merge === undefined || !canManage
          ? {}
          : {
              rowSelection: {
                selectedRowKeys: selected,
                onChange: (keys: React.Key[]) => setSelected(keys.map(String)),
              },
            })}
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
          ...(canManage ? [actionsColumn] : []),
        ]}
      />

      {/* Which of these is the right name is the whole question a merge asks: the names on the
          selected rows are offered, and anything else can be typed over them (docs/11 §11.12a). */}
      {merge !== undefined && (
        <Modal
          open={merging}
          title={t('admin.catalogues.mergeTitle', { count: chosen.length })}
          okText={t('admin.catalogues.actions.mergeConfirm')}
          cancelText={t('common.actions.cancel')}
          confirmLoading={mergeRows.isPending}
          onCancel={() => setMerging(false)}
          onOk={() => void mergeForm.submit()}
          destroyOnClose
        >
          <Form
            form={mergeForm}
            layout="vertical"
            onFinish={(values: MergeValues) => mergeRows.mutate(values)}
          >
            <Form.Item
              name="name"
              label={t('admin.catalogues.fields.mergedName')}
              rules={[{ required: true, message: t('admin.catalogues.fields.nameRequired') }]}
              extra={t('admin.catalogues.fields.mergedNameHint')}
            >
              <AutoComplete
                options={chosen.map((row) => ({ value: merge.label(row) }))}
                filterOption={false}
              />
            </Form.Item>
            {merge.fields?.(chosen)}
          </Form>
        </Modal>
      )}

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
