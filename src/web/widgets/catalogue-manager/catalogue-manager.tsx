'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
  type TableColumnType,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useRef, useState, type ReactNode } from 'react';
import type { CatalogueReadingState } from '../../../shared/contracts/common';
import { useErrorMessage } from '../../shared/lib';
import { AnalystUnavailableNotice } from './analyst-unavailable-notice';

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
// a delete behind a confirmation that says how far it reaches (docs/11 §11.12a). Written once because
// people, subjects and their kinds differ only in their columns and their fields — and a catalogue
// that behaves differently from the catalogue next to it is a catalogue nobody trusts.
// What a merge always asks for, whatever is being merged: which of these is the right name. Any
// extra half — a subject's kind — is added by the screen (docs/11 §11.12a).
// Every field a merge asks about is a name or an id, so one string map covers them; a screen that
// needs more shape than that is a screen with a form of its own.
export type MergeValues = Record<string, string>;

// The analyst's tidier reading of what a hand-picked merge dialog should open with
// (docs/11 §11.12a): the name (and any extra values, like a subject's kind), and the distinct other
// spellings the note's "also known as" line is composed from.
export type MergePrefill = {
  values: MergeValues;
  aka: readonly string[];
};

// One group the analyst proposes folding (docs/05 §5.6c), as every catalogue's contract answers it:
// the rows, the spelling worth keeping, the distinct other spellings — plus whatever else the
// dialog's extra fields want decided, the kind for subjects.
export type CatalogueSuggestionGroup = {
  ids: string[];
  name: string;
  aka: string[];
  extraValues?: MergeValues;
};

// The whole reading, in the three states of docs/05 §5.6c: answered (groups included, empty ones
// too), no analyst configured, or asked and could not answer — which is not an answer of none.
export type CatalogueSuggestionsReading = {
  state: CatalogueReadingState;
  groups: CatalogueSuggestionGroup[];
  // Subjects only: living rows whose name is a kind rather than a thing, offered for deletion
  // (docs/11 §11.12a).
  placeholderIds?: string[];
};

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
  suggestions,
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
    // What this row already carries in its note, so a merge can keep it (docs/11 §11.12a).
    note?: (row: Row) => string | null;
    // How much note the surviving row may hold, as its contract says — shown as a count rather
    // than discovered when the server refuses the merge, and the bound every prefill is cut to:
    // a default the server would refuse is a bug, not a default (docs/11 §11.12a).
    noteMaxLength?: number;
    // Whatever else the merged row needs decided — the kind, for subjects.
    fields?: (rows: Row[]) => ReactNode;
    initialValues?: (rows: Row[]) => MergeValues;
    onMerge: (rows: Row[], values: MergeValues) => Promise<unknown>;
    // A tidier reading of what the dialog should open with, fetched while the raw prefill is
    // already on screen; it lands only while the person has not started editing, because a form
    // must never fight its user (docs/11 §11.12a). `null` means "keep the raw prefill".
    prefill?: (rows: Row[]) => Promise<MergePrefill | null>;
  };
  // The duplicates the analyst knows of, above the table (docs/11 §11.12a, docs/05 §5.6c). The
  // manager owns the asking and the drawing; the screen says only where to ask and what to call
  // things. Asked once per visit and kept: a merged group leaves the panel because its rows leave
  // the catalogue, not because the server is asked again — it never remembers being refused, so
  // re-asking is re-proposing.
  suggestions?: {
    // The screen's own words above the groups.
    title: string;
    queryKey: readonly unknown[];
    fetch: () => Promise<CatalogueSuggestionsReading>;
    // The line naming a group's (or a placeholder's) row — subjects prefix each name with its kind.
    // Defaults to the merge label.
    rowLabel?: (row: Row) => string;
    // Subjects only: the heading over the placeholder rows offered for deletion.
    placeholdersTitle?: string;
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
  // Which opening of the merge dialog is current, so a tidy prefill that arrives after the dialog
  // was closed or reopened lands nowhere.
  const mergeSession = useRef(0);

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

  // Cut to the contract's limit from the end: `maxLength` on the field stops typing, not a value
  // set by code, and a prefill past the limit used to throw a client-side parse before any request
  // was made (M48.1).
  const clampNote = (note: string): string =>
    merge?.noteMaxLength === undefined ? note : note.slice(0, merge.noteMaxLength);

  // Nothing written on the merged rows is thrown away (docs/11 §11.12a): the spellings that are
  // about to disappear, and then every note any of the selected rows carried, one per line. The
  // person editing it deletes what is noise — but the default is "keep everything", because the
  // alternative is a merge that quietly destroys the one line somebody wrote a year ago to explain
  // which flat this is.
  const composeNote = (aka: readonly string[], rows: Row[]): string => {
    const notes = rows
      .map((row) => merge?.note?.(row) ?? '')
      .map((note) => note.trim())
      .filter((note) => note !== '');
    return clampNote(
      [
        ...(aka.length === 0
          ? []
          : [t('admin.catalogues.fields.alsoKnownAs', { names: aka.join(', ') })]),
        ...notes,
      ].join('\n'),
    );
  };

  // The raw prefill's aka line: every distinct selected name except the survivor's.
  const keptNote = (rows: Row[], survivor: string): string => {
    if (merge === undefined) return '';
    const vanishing = [...new Set(rows.map((row) => merge.label(row)))].filter(
      (name) => name !== survivor,
    );
    return composeNote(vanishing, rows);
  };

  // One door for every way the dialog opens — the Merge button over a hand-picked selection, and a
  // suggestion's own button (docs/11 §11.12a).
  const openMerge = (rows: Row[], values: MergeValues): void => {
    mergeSession.current += 1;
    setSelected(rows.map((row) => row.id));
    mergeForm.resetFields();
    mergeForm.setFieldsValue({ ...values, note: clampNote(values.note ?? '') });
    setMerging(true);
  };

  const openManualMerge = (): void => {
    if (merge === undefined) return;
    const first = chosen[0];
    const values =
      merge.initialValues?.(chosen) ?? (first === undefined ? {} : { name: merge.label(first) });
    const rows = chosen;
    openMerge(rows, { ...values, note: values.note ?? keptNote(rows, values.name ?? '') });

    // The raw prefill is already on screen; the tidy reading replaces it only if this is still the
    // same dialog and the person has not touched it (docs/11 §11.12a).
    const session = mergeSession.current;
    void merge.prefill?.(rows).then((tidied) => {
      if (tidied === null || tidied === undefined) return;
      if (session !== mergeSession.current || mergeForm.isFieldsTouched()) return;
      mergeForm.setFieldsValue({ ...tidied.values, note: composeNote(tidied.aka, rows) });
    });
  };

  // The analyst's proposals (docs/05 §5.6c), asked by the manager because every catalogue asks the
  // same way; only an admin can act on them, so only an admin's visit asks.
  const suggested = useQuery({
    queryKey: suggestions?.queryKey ?? ['catalogue-suggestions', 'unconfigured'],
    queryFn: () => {
      if (suggestions === undefined) return Promise.reject(new Error('no suggestions source'));
      return suggestions.fetch();
    },
    enabled: suggestions !== undefined && canManage,
    staleTime: Infinity,
  });
  const [panelClosed, setPanelClosed] = useState(false);

  const alive = new Map(rows.map((row) => [row.id, row]));
  const reading = suggested.data;
  // A group survives only whole: a row merged or deleted since the answer takes its group with it.
  const groups = (reading?.state === 'ANSWERED' ? reading.groups : []).filter((group) =>
    group.ids.every((id) => alive.has(id)),
  );
  const placeholders = (
    reading?.state === 'ANSWERED' ? (reading.placeholderIds ?? []) : []
  ).flatMap((id) => {
    const row = alive.get(id);
    return row === undefined ? [] : [row];
  });
  // The third state (docs/05 §5.6c): the analyst was asked and could not answer. Said out loud,
  // because an empty panel area used to mean this and "no duplicates" alike (docs/11 §11.12a).
  const unavailable = reading?.state === 'UNAVAILABLE';

  const groupRows = (group: CatalogueSuggestionGroup): Row[] =>
    group.ids.flatMap((id) => {
      const row = alive.get(id);
      return row === undefined ? [] : [row];
    });

  // The analyst's answer, prefilled: its spelling as the name, its extras (the kind), its tidy aka
  // line over everything the rows carried (docs/11 §11.12a).
  const suggestedValues = (group: CatalogueSuggestionGroup): MergeValues => ({
    name: group.name,
    ...group.extraValues,
    note: composeNote(group.aka, groupRows(group)),
  });

  const rowLabel = (row: Row): string =>
    suggestions?.rowLabel?.(row) ?? merge?.label(row) ?? row.id;

  const suggestionsPanel = (): ReactNode => {
    if (suggestions === undefined || panelClosed) return null;
    if (unavailable) return <AnalystUnavailableNotice onClose={() => setPanelClosed(true)} />;
    if (groups.length === 0 && placeholders.length === 0) return null;
    return (
      <Alert
        type="info"
        showIcon
        closable
        style={{ marginBottom: 16 }}
        onClose={() => setPanelClosed(true)}
        message={suggestions.title}
        description={
          <Space direction="vertical" size="small">
            {groups.map((group) => (
              <Space key={group.ids.join(':')} wrap>
                <Typography.Text>{groupRows(group).map(rowLabel).join(', ')}</Typography.Text>
                <Button
                  size="small"
                  onClick={() => openMerge(groupRows(group), suggestedValues(group))}
                >
                  {t('admin.catalogues.actions.merge', { count: group.ids.length })}
                </Button>
              </Space>
            ))}
            {/* Analysis noise is deleted one confirmed row at a time, not swept
                (docs/11 §11.12a). */}
            {placeholders.length > 0 && (
              <Typography.Text strong>{suggestions.placeholdersTitle}</Typography.Text>
            )}
            {placeholders.map((row) => (
              <Space key={row.id} wrap>
                <Typography.Text>{rowLabel(row)}</Typography.Text>
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
            ))}
          </Space>
        }
      />
    );
  };

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
            <Button onClick={openManualMerge}>
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
      {/* The screen notices first, where the screen has something to notice (docs/11 §11.12a). */}
      {canManage && suggestionsPanel()}

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
            {/* Prefilled with what the rows carried, and editable before confirming: a merge must
                not be the thing that loses the note explaining which flat this is
                (docs/11 §11.12a). */}
            <Form.Item
              name="note"
              label={t('admin.catalogues.fields.note')}
              extra={t('admin.catalogues.fields.mergedNoteHint')}
              // The contract's limit as a field rule too: `maxLength` only stops typing, and a
              // value past the limit must fail here, in front of the person, rather than as a
              // parse error behind the form (M48.1).
              rules={
                merge.noteMaxLength === undefined
                  ? []
                  : [
                      {
                        max: merge.noteMaxLength,
                        message: t('admin.catalogues.fields.noteTooLong', {
                          max: merge.noteMaxLength,
                        }),
                      },
                    ]
              }
            >
              <Input.TextArea
                rows={4}
                {...(merge.noteMaxLength === undefined
                  ? {}
                  : { maxLength: merge.noteMaxLength, showCount: true })}
              />
            </Form.Item>
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
