'use client';

import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  theme,
  type TableColumnType,
  type TableProps,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ZodType } from 'zod';
import {
  DEFAULT_CATALOGUE_ORDER,
  type CatalogueOrder,
  type CatalogueReadingState,
} from '../../../shared/contracts/common';
import { useErrorMessage } from '../../shared/lib';

// The arrangement a catalogue screen is read in (docs/11 §11.12a): the sort name the API knows it
// by, the direction, and the one way to change both. Held by the screen because the screen's query
// carries it to the server — a page of a ten-thousand-row catalogue sorted in the browser is a lie
// — and living in the widget because all three screens hold it identically.
export type CatalogueSortState<Sort extends string = string> = {
  sort: Sort;
  order: CatalogueOrder;
  // Takes the column's own sort name, which is a plain string where the table hands it over, and
  // `null` for the click that turns sorting off — which puts the catalogue back in the order it
  // opened in rather than in no order at all.
  apply: (sort: string, order: CatalogueOrder | null) => void;
};

export function useCatalogueSort<Sort extends string>(
  // The catalogue's own closed sort enum: a name it does not hold is ignored here rather than sent
  // to an API that would refuse it (docs/07 §7.3).
  sortSchema: ZodType<Sort>,
  initialSort: Sort,
  initialOrder: CatalogueOrder = DEFAULT_CATALOGUE_ORDER,
): CatalogueSortState<Sort> {
  const [arrangement, setArrangement] = useState<{ sort: Sort; order: CatalogueOrder }>({
    sort: initialSort,
    order: initialOrder,
  });
  const apply = useCallback(
    (sort: string, order: CatalogueOrder | null) => {
      if (order === null) {
        setArrangement({ sort: initialSort, order: initialOrder });
        return;
      }
      const parsed = sortSchema.safeParse(sort);
      if (parsed.success) setArrangement({ sort: parsed.data, order });
    },
    [sortSchema, initialSort, initialOrder],
  );
  return { ...arrangement, apply };
}

// The fold state of the duplicates panel, kept the way §11.3's group folds are: one entry in
// `window.sessionStorage`, lasting the tab and nothing longer, deliberately not in the URL.
function readFolded(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(key) === '1';
  } catch {
    // A store that cannot be read is a panel that opens — the harmless way to be wrong about this.
    return false;
  }
}

function writeFolded(key: string, folded: boolean): void {
  try {
    if (folded) window.sessionStorage.setItem(key, '1');
    else window.sessionStorage.removeItem(key);
  } catch {
    // A full store is not a reason folding should break.
  }
}

export type CatalogueColumn<Row> = {
  title: string;
  key: string;
  render: (row: Row) => ReactNode;
  // The name this column travels to the server as, on the columns that sort: a click sends the
  // whole question back to the API rather than reordering the page in the browser
  // (docs/11 §11.12a).
  sortKey?: string;
  // AntD's own column extras, for the few columns that want them — a filter over the kinds, say.
  filters?: Array<{ text: string; value: string }>;
  // Taken from the table's own column type rather than restated: AntD's filter value is wider than
  // it looks, and a hand-written signature here would only be wrong in a new version.
  onFilter?: TableColumnType<Row>['onFilter'];
  // A filter already in force when the screen opens — the kind a link into /subjects carries
  // (docs/11 §11.12a).
  defaultFilteredValue?: string[];
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
// (docs/11 §11.12a): the name (and any extra values, like a subject's kind), the distinct other
// spellings, and the composed note itself where the analyst wrote one — its fold of everything the
// merged rows held, written for the analysis that will read it when the next document arrives
// (docs/05 §5.6c). Without one, the aka line and the rows' own notes are composed here as before.
export type MergePrefill = {
  values: MergeValues;
  aka: readonly string[];
  note?: string | null | undefined;
};

// One group the analyst proposes folding (docs/05 §5.6c), as every catalogue's contract answers it:
// the rows, the spelling worth keeping, the distinct other spellings — plus whatever else the
// dialog's extra fields want decided, the kind for subjects.
export type CatalogueSuggestionGroup = {
  ids: string[];
  name: string;
  aka: string[];
  // The analyst's composed note for the survivor (docs/05 §5.6c); `null` when it offered none and
  // the raw concatenation stands in its place.
  note?: string | null | undefined;
  extraValues?: MergeValues;
};

// The whole reading, in the three states of docs/05 §5.6c: answered (groups included, empty ones
// too), no analyst configured, or asked and could not answer — which is not an answer of none.
export type CatalogueSuggestionsReading = {
  state: CatalogueReadingState;
  // When this reading was computed, from the server's in-process cache (docs/07 §7.3): a screen
  // that shows an answer owes its reader the answer's age. `null` in the states carrying none.
  computedAt: string | null;
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
  sorting,
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
    // `refresh` drops the server's cached reading and asks the analyst anew (docs/07 §7.3).
    fetch: (options: { refresh: boolean }) => Promise<CatalogueSuggestionsReading>;
    // The line naming a group's (or a placeholder's) row — subjects prefix each name with its kind.
    // Defaults to the merge label.
    rowLabel?: (row: Row) => string;
    // Subjects only: the heading over the placeholder rows offered for deletion.
    placeholdersTitle?: string;
  };
  // How the catalogue is arranged and how a header click changes it; the screen's query carries it
  // to the server (docs/11 §11.12a). A catalogue with no sortable column simply omits it.
  sorting?: CatalogueSortState<string>;
}) {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<Values>();

  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeForm] = Form.useForm<MergeValues>();
  // Which opening of the merge dialog is current, so a tidy prefill that arrives after the dialog
  // was closed or reopened lands nowhere.
  const mergeSession = useRef(0);

  // A dialog opens with focus on the control its opener came for (docs/11 §11.14): a form that
  // arrives prefilled focuses its primary action — the merge dialog's confirm, the edit dialog's
  // Save — and a form that expects typing focuses its first empty field, the create dialog's name.
  // Handed over a tick after open, because the dialog focuses its own wrapper on mount and would
  // otherwise take it straight back.
  const mergeConfirmRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const formBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!merging) return;
    const timer = window.setTimeout(() => mergeConfirmRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [merging]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      // The name field is the one every catalogue's create dialog asks to be typed into first;
      // AntD gives the control the field's own name as its id.
      if (editing === null) formBodyRef.current?.querySelector<HTMLElement>('#name')?.focus();
      else saveRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, editing]);

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

  // What the dialog's note field should hold when the analyst has been heard from: its own composed
  // note where it wrote one — each distinct spelling once, the misreadings dropped, the identifying
  // details kept, written for the analysis that will read it (docs/05 §5.6c) — and the raw
  // composition of the aka line and the rows' notes where it did not, which is the same degradation
  // `available: false` gets.
  const analystNote = (note: string | null | undefined, aka: readonly string[], rows: Row[]) =>
    note === null || note === undefined || note.trim() === ''
      ? composeNote(aka, rows)
      : clampNote(note);

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
      mergeForm.setFieldsValue({
        ...tidied.values,
        note: analystNote(tidied.note, tidied.aka, rows),
      });
    });
  };

  // The analyst's proposals (docs/05 §5.6c), asked by the manager because every catalogue asks the
  // same way; only an admin can act on them, so only an admin's visit asks. Asked once per visit
  // and kept: the server never remembers being refused, so re-asking is re-proposing.
  const suggestionsKey = suggestions?.queryKey ?? ['catalogue-suggestions', 'unconfigured'];
  const suggested = useQuery({
    queryKey: suggestionsKey,
    queryFn: () => {
      if (suggestions === undefined) return Promise.reject(new Error('no suggestions source'));
      return suggestions.fetch({ refresh: false });
    },
    enabled: suggestions !== undefined && canManage,
    staleTime: Infinity,
  });

  // Recompute (docs/11 §11.12a): the reader who distrusts the answer asks afresh, which drops the
  // server's cached reading (`?refresh=1`) — and it spins in place rather than emptying the panel,
  // because a panel that vanishes while it thinks is the banner this one replaced.
  const recompute = useMutation({
    mutationFn: () => {
      if (suggestions === undefined) return Promise.reject(new Error('no suggestions source'));
      return suggestions.fetch({ refresh: true });
    },
    onSuccess: (reading) => queryClient.setQueryData(suggestionsKey, reading),
    onError,
  });

  // Folding is the screen's own memory and lasts the tab, the way §11.3's group folds are kept:
  // `window.sessionStorage`, never the URL, and never a filter — a folded panel hides nothing from
  // the table below it.
  const foldKey = `legere:catalogue-panel-folded:${suggestionsKey.join(':')}`;
  const [folded, setFolded] = useState(() => readFolded(foldKey));
  const fold = (next: boolean): void => {
    setFolded(next);
    writeFolded(foldKey, next);
  };

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
  // A suggested merge opens tidy from the start, the answer having come with the suggestion
  // (docs/11 §11.12a).
  const suggestedValues = (group: CatalogueSuggestionGroup): MergeValues => ({
    name: group.name,
    ...group.extraValues,
    note: analystNote(group.note, group.aka, groupRows(group)),
  });

  const rowLabel = (row: Row): string =>
    suggestions?.rowLabel?.(row) ?? merge?.label(row) ?? row.id;

  // The one line the panel always shows, in the three honest states of docs/05 §5.6c — never an
  // empty space, because an empty space used to mean "no duplicates" and "the provider answered
  // 500" alike, which is how the feature stayed dead on a live instance.
  const summaryLine = (): ReactNode => {
    if (suggested.isPending || recompute.isPending)
      return <Typography.Text>{t('admin.catalogues.suggestions.computing')}</Typography.Text>;
    if (reading === undefined || reading.state === 'UNCONFIGURED')
      return (
        <Typography.Text type="secondary">
          {t('admin.catalogues.suggestions.unconfigured')}
        </Typography.Text>
      );
    if (reading.state === 'UNAVAILABLE')
      return <Typography.Text>{t('admin.catalogues.suggestions.unavailable')}</Typography.Text>;
    return (
      <Typography.Text>
        {t('admin.catalogues.suggestions.summary', { count: groups.length })}
        {reading.computedAt !== null && reading.computedAt !== undefined && (
          <Typography.Text type="secondary" title={reading.computedAt}>
            {' · '}
            {t('admin.catalogues.suggestions.computedAt', {
              time: new Date(reading.computedAt).toLocaleString(),
            })}
          </Typography.Text>
        )}
      </Typography.Text>
    );
  };

  // Above the table on each of the three screens, permanently: how many duplicate groups the
  // analyst knows of, when it looked, a fold control and Recompute (docs/11 §11.12a). An admin
  // arriving at a catalogue of a hundred and thirty names should not be startled by a banner that
  // materialises out of nothing and vanishes back into it.
  const suggestionsPanel = (): ReactNode => {
    if (suggestions === undefined) return null;
    const showsGroups = groups.length > 0 || placeholders.length > 0;
    return (
      <Alert
        // The warning tone for the one state that is a fact about the instance rather than about
        // the catalogue; no provider error text, which an admin cannot act on (docs/06 §6.7).
        type={unavailable ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          <Space wrap>
            {showsGroups && (
              <Button
                type="text"
                size="small"
                aria-expanded={!folded}
                aria-label={
                  folded
                    ? t('admin.catalogues.suggestions.unfold')
                    : t('admin.catalogues.suggestions.fold')
                }
                icon={folded ? <RightOutlined /> : <DownOutlined />}
                onClick={() => fold(!folded)}
              />
            )}
            {summaryLine()}
            {/* Nothing to press where there is no analyst to ask (docs/11 §11.12a); everywhere
                else Recompute is also the retry the unavailable state offers. */}
            {reading?.state !== 'UNCONFIGURED' && (
              <Button size="small" loading={recompute.isPending} onClick={() => recompute.mutate()}>
                {t('admin.catalogues.actions.recompute')}
              </Button>
            )}
          </Space>
        }
        {...(folded || !showsGroups
          ? {}
          : {
              description: (
                <Space direction="vertical" size="small">
                  <Typography.Text strong>{suggestions.title}</Typography.Text>
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
              ),
            })}
      />
    );
  };

  // AntD's own vocabulary for the two directions, taken from the column type rather than spelled as
  // bare strings, which would widen to `string` in the object below.
  const ascend: TableColumnType<Row>['sortOrder'] = 'ascend';
  const descend: TableColumnType<Row>['sortOrder'] = 'descend';

  // What the table reports when a header is clicked, turned into the arrangement the screen's query
  // carries to the server (docs/11 §11.12a). Multi-column sorting is not offered, so the first
  // result is the whole answer.
  type Sorter = Parameters<NonNullable<TableProps<Row>['onChange']>>[2];
  const applySorter = (sorter: Sorter): void => {
    if (sorting === undefined) return;
    const clicked = Array.isArray(sorter) ? sorter[0] : sorter;
    if (clicked === undefined) return;
    const column = columns.find((candidate) => candidate.key === clicked.columnKey);
    if (column?.sortKey === undefined) return;
    // The third click takes the sort off; the catalogue then goes back to the order it opened in.
    sorting.apply(
      column.sortKey,
      clicked.order === ascend ? 'asc' : clicked.order === descend ? 'desc' : null,
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
    // A flex column filling the shell's content area, so the action bar below stands at the foot of
    // the viewport even under a table shorter than the screen.
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <Card title={title}>
        {/* The screen notices first, where the screen has something to notice (docs/11 §11.12a). */}
        {canManage && suggestionsPanel()}

        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText }}
          onChange={(_pagination, _filters, sorter) => applySorter(sorter)}
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
              ...(column.defaultFilteredValue === undefined
                ? {}
                : { defaultFilteredValue: column.defaultFilteredValue }),
              // `sorter: true` is AntD's way of saying "the server sorts this": the table draws the
              // control and reports the click, and reorders nothing itself (docs/11 §11.12a).
              ...(column.sortKey === undefined || sorting === undefined
                ? {}
                : {
                    sorter: true,
                    sortOrder:
                      sorting.sort === column.sortKey
                        ? sorting.order === 'asc'
                          ? ascend
                          : descend
                        : null,
                  }),
            })),
            ...(canManage ? [actionsColumn] : []),
          ]}
        />
      </Card>

      {/* The actions stand at the foot of the screen, and stay there (docs/11 §11.12a): New always,
          Merge the moment two or more rows are selected — a selection made at row three hundred
          must not cost a scroll back to the top. Sticky and in flow rather than floating fixed:
          the table ends above the bar, never under it. */}
      <div
        role="toolbar"
        aria-label={t('admin.catalogues.actionsBar')}
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 'auto',
          padding: '12px 16px',
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          zIndex: 10,
        }}
      >
        <Space>
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
          {/* Only once there is something to fold together: a merge of one row is not a merge. */}
          {canManage && merge !== undefined && selected.length > 1 && (
            <Button onClick={openManualMerge}>
              {t('admin.catalogues.actions.merge', { count: selected.length })}
            </Button>
          )}
        </Space>
      </div>

      {/* Which of these is the right name is the whole question a merge asks: the names on the
          selected rows are offered, and anything else can be typed over them (docs/11 §11.12a). */}
      {merge !== undefined && (
        <Modal
          open={merging}
          title={t('admin.catalogues.mergeTitle', { count: chosen.length })}
          onCancel={() => setMerging(false)}
          destroyOnClose
          // Its own footer, because the confirm button is what the dialog opens focused on
          // (docs/11 §11.14) and AntD's built-in one offers no handle to reach it by.
          footer={
            <>
              <Button onClick={() => setMerging(false)}>{t('common.actions.cancel')}</Button>
              <Button
                type="primary"
                ref={mergeConfirmRef}
                loading={mergeRows.isPending}
                onClick={() => void mergeForm.submit()}
              >
                {t('admin.catalogues.actions.mergeConfirm')}
              </Button>
            </>
          }
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
        onCancel={() => setOpen(false)}
        destroyOnClose
        // Same reason as the merge dialog's: the primary action is a focus target (docs/11 §11.14).
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.actions.cancel')}</Button>
            <Button
              type="primary"
              ref={saveRef}
              loading={save.isPending}
              onClick={() => void form.submit()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div ref={formBodyRef}>
          <Form
            form={form}
            layout="vertical"
            initialValues={initialValues}
            onFinish={(values: Values) => save.mutate(values)}
          >
            {fields(editing)}
          </Form>
        </div>
      </Modal>
    </div>
  );
}
