'use client';

import {
  AutoComplete,
  Button,
  DatePicker,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ResponsiveTable as Table, DefinitionList, UserAttribution } from '../../../shared/ui';
import dayjs from 'dayjs';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DOCUMENT_STEPS,
  type DocumentDetailDto,
  type DocumentEventDto,
  type DocumentResetEntry,
  type DocumentStep,
} from '../../../../shared/contracts/documents';
import {
  fieldSchemaFor,
  type DocumentFieldSchema,
  type DocumentFieldSpec,
} from '../../../../shared/contracts/document-fields';
import { type PageFormat } from '../../../../shared/contracts/enums';
import { formatBytes } from '../../../shared/lib';
import {
  NO_CATALOGUE,
  type MetaChange,
  type Draft,
  mergeById,
  living,
  fieldDraftOf,
  sameIds,
  patchValueOf,
  sameFieldValue,
  pendingState,
  type FieldDraft,
  formatFieldValue,
  displayLanguage,
  placeOf,
  isDeleted,
  isNewName,
  documentsHref,
  distinctKinds,
  yearOf,
  formatDate,
  PAGE_FORMATS,
  languageOptions,
  COUNTRY_OPTIONS,
  placeWaysIn,
} from '../model/details';
import { isRecord, useDocumentEvents, stepCost } from '../model/events';

// Everything about the document that is not the document, in three titled sections (docs/11 §11.5):
// **What it says** — every row a machine read off the page, which is the only one of the three
// anybody may correct, and which therefore carries the Edit button in its own heading; **What it
// is** — the facts of the artifact, which nothing here edits; **What it cost** — what the pipeline
// spent getting here. What the document is made *of* is the Files tab's question, and is answered
// there.
//
// This component is the pane and its first section; the other two are drawn beside it and are held
// apart on purpose (below), so that opening the form re-renders the rows the form can touch and
// nothing else.
//
// 🔒 `readOnly` is the pane drawn for somebody who is looking at a document rather than working on
// it — the peek of §11.5e. It is not "the same pane with the inputs disabled": the form is never
// opened at all, so the catalogues it would need are not asked for and the keyboard shortcut that
// opens it does not listen. What is left is the three sections, read.
export function DetailsPane({
  document,
  documentTypes = NO_CATALOGUE,
  people = NO_CATALOGUE,
  onCreatePerson,
  subjects = NO_CATALOGUE,
  subjectKinds = NO_CATALOGUE,
  onCreateSubject,
  onSave,
  saving = false,
  readOnly = false,
}: {
  document: DocumentDetailDto;
  documentTypes?: Array<{ id: string; slug: string; name: string }>;
  people?: Array<{ id: string; name: string }>;
  onCreatePerson?: (name: string) => Promise<string>;
  subjects?: Array<{ id: string; kindId: string; kind: string; name: string }>;
  subjectKinds?: Array<{ id: string; name: string }>;
  onCreateSubject?: (kind: string, name: string) => Promise<string>;
  onSave?: (input: MetaChange) => void;
  saving?: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState('');
  const [subjectSearch, setSubjectSearch] = useState('');
  const [kind, setKind] = useState('');
  const [reset, setReset] = useState<DocumentResetEntry[]>([]);
  const editing = draft !== null;

  // The field schema the document's type carries, if any (docs/03 §3.3.10a): the typed-fields group
  // below exists only where this is not null.
  const schema = fieldSchemaFor(document.documentType?.slug);
  // The stored values, when they speak the schema being drawn: after a manual type change the old
  // answer speaks the old type's schema and the `fields` step is already queued to replace it
  // wholesale (docs/03 §3.3.10a) — its badge stands over the em dashes meanwhile.
  const extractedValues: Record<string, unknown> =
    schema !== null &&
    document.extracted !== null &&
    document.extracted.schema.slug === schema.typeSlug
      ? document.extracted.values
      : {};

  // 🔒 The options a value may take are the catalogue *and* whatever this document already carries.
  // The two come from different places — the catalogue is fetched once, the document is polled — so
  // a name the analysis wrote a moment ago is on the document before it is in the catalogue, and a
  // name somebody deleted is on the document and never in it again. Given only the catalogue, the
  // select finds no label for such a value and rc-select renders the raw id, which is where the
  // UUIDs came from. Taking the union removes the whole class: a value always has a name, even when
  // the catalogue is stale, was deleted from, or failed to load at all.
  const personOptions = useMemo(
    () => mergeById(people.map(living), document.people),
    [people, document.people],
  );
  const subjectOptions = useMemo(
    () => mergeById(subjects.map(living), document.subjects),
    [subjects, document.subjects],
  );

  // A name the catalogue has let go is struck through rather than hidden: the link survives a
  // deletion on purpose (03 §3.3.19), and a reader looking at a document has no other way to tell a
  // name that is still a choice from one that is only a record.
  const nameOrRecord = (label: ReactNode, deleted: boolean | undefined): ReactNode =>
    deleted !== true ? (
      label
    ) : (
      <Tooltip title={t('viewer.details.deletedName')}>
        <span style={{ textDecoration: 'line-through' }}>{label}</span>
      </Tooltip>
    );

  // Keyed by the row's own id rather than by position: two people may share a name, and a list that
  // reorders would otherwise carry a tooltip from one to the other.
  //
  // Nothing at all is the empty string rather than an empty array, so the row falls through to the
  // definition list's em dash: "nothing was detected" is said out loud, and a blank cell reads as a
  // rendering bug (docs/11 §11.5).
  const joinNames = (names: ReadonlyArray<{ id: string; node: ReactNode }>): ReactNode =>
    names.length === 0
      ? ''
      : names.map((name, index) => (
          <Fragment key={name.id}>
            {index > 0 && ', '}
            {name.node}
          </Fragment>
        ));

  // Every name in the reading pane is a way into the documents filed under it (docs/11 §11.5) — a
  // detail read on one document is how the next one is found.
  //
  // A name the catalogue has let go is the exception, and stays plain struck-through text: the browse
  // screen it would point at resolves its own heading from the live catalogue and answers 404 for a
  // deleted row (docs/11 §11.4), so the link would lead nowhere. A record is not a way in.
  const wayIn = (label: string, href: string, deleted: boolean): ReactNode =>
    deleted ? nameOrRecord(label, true) : <Link href={href}>{label}</Link>;

  // Which subjects the pane is describing: the document's own, or — while the form is open — the ones
  // the multi-select currently holds, so the kind row keeps up with what is being chosen.
  const chosenSubjects = useMemo(
    () =>
      draft === null
        ? document.subjects
        : draft.subjectIds.flatMap((subjectId) => {
            const found = subjectOptions.find((subject) => subject.id === subjectId);
            return found === undefined ? [] : [found];
          }),
    [draft, document.subjects, subjectOptions],
  );

  // The kinds those subjects are filed under, each once. Several subjects of one kind — two flats,
  // four vehicles — say "flat" once rather than repeating it per object: this row answers "what kind
  // of thing is this about" and the row below answers "which ones". They are deliberately not paired
  // off position by position, which is the running-together the split exists to end; when the kinds
  // differ, each kind is still a way into everything of that kind, and each object into itself.
  const kinds = useMemo(() => {
    const seen = new Map<string, string>();
    for (const subject of chosenSubjects) {
      if (!seen.has(subject.kindId)) seen.set(subject.kindId, subject.kind);
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [chosenSubjects]);

  const startEditing = (): void => {
    setReset([]);
    setDraft({
      typeId: document.documentType?.id ?? null,
      peopleIds: document.people.map((person) => person.id),
      subjectIds: document.subjects.map((subject) => subject.id),
      documentDate: document.documentDate,
      pageFormat: document.pageFormat,
      languages: document.languages,
      country: document.country,
      city: document.city ?? '',
      // The scalar typed fields, each in the shape its input works in; a table gets no draft
      // because the form does not edit one (docs/11 §11.5).
      fields: Object.fromEntries(
        (schema?.fields ?? [])
          .filter((spec) => spec.kind !== 'table')
          .map((spec) => [spec.key, fieldDraftOf(spec, extractedValues[spec.key])]),
      ),
    });
  };

  const stopEditing = (): void => {
    setDraft(null);
    setReset([]);
  };

  // "Put it back to what was read." The draft shows the machine's value immediately; the server is
  // told it was a reset rather than a choice, so a reset documentType becomes AUTO again and the next
  // run may classify it (docs/03 §3.3.10).
  const resetFields = (fields: DocumentResetEntry[]): void => {
    if (draft === null) return;
    setReset((chosen) => [...new Set([...chosen, ...fields])]);
    const next = { ...draft, fields: { ...draft.fields } };
    if (fields.includes('documentType')) next.typeId = autoType?.id ?? null;
    if (fields.includes('languages')) next.languages = document.auto.languages ?? [];
    if (fields.includes('country')) next.country = document.auto.country ?? null;
    if (fields.includes('city')) next.city = document.auto.city ?? '';
    if (fields.includes('documentDate')) next.documentDate = document.auto.date ?? null;
    // A typed field goes back to the model's own last reading, in the draft as it will on the
    // server (docs/03 §3.3.10a).
    for (const entry of fields) {
      if (!entry.startsWith('fields.')) continue;
      const key = entry.slice('fields.'.length);
      const spec = schema?.fields.find((candidate) => candidate.key === key);
      if (spec !== undefined && spec.kind !== 'table') {
        next.fields[key] = fieldDraftOf(spec, document.auto.fields?.[key]);
      }
    }
    setDraft(next);
  };

  // Only what actually changed: an untouched field must not be sent, or every save would count as a
  // manual assignment and a documentType the classifier chose would silently become a person's choice
  // (docs/03 §3.3.10).
  const save = (): void => {
    if (draft === null) return;
    const change: MetaChange = {};
    // A field that was reset travels as a reset, never as a value: sending the same value by hand
    // would mark it as somebody's choice, which is the opposite of what was asked for.
    if (!reset.includes('documentType') && draft.typeId !== (document.documentType?.id ?? null)) {
      change.typeId = draft.typeId;
    }
    // Links, not values: the whole set travels, so what counts as a change is which rows are in it
    // and not the order the multi-select happened to leave them in. Neither has a reset — a person
    // the analysis named is a link, and PATCH has no reset for one — so the set alone decides.
    const named = document.people.map((person) => person.id);
    if (!sameIds(draft.peopleIds, named)) change.peopleIds = draft.peopleIds;
    const about = document.subjects.map((subject) => subject.id);
    if (!sameIds(draft.subjectIds, about)) change.subjectIds = draft.subjectIds;
    // A calendar day, compared as the plain `yyyy-mm-dd` it is held as.
    if (draft.pageFormat !== document.pageFormat) change.pageFormat = draft.pageFormat;
    if (!reset.includes('documentDate') && draft.documentDate !== document.documentDate) {
      change.documentDate = draft.documentDate;
    }
    if (
      !reset.includes('languages') &&
      draft.languages.join('|') !== document.languages.join('|')
    ) {
      change.languages = draft.languages;
    }
    if (!reset.includes('country') && draft.country !== document.country) {
      change.country = draft.country;
    }
    const city = draft.city.trim() === '' ? null : draft.city.trim();
    if (!reset.includes('city') && city !== document.city) change.city = city;
    // Only the typed fields that changed, each as its stored shape; an emptied input travels as
    // null, which clears value and source both (docs/03 §3.3.10a). A field that was reset travels
    // in `reset` below, never as a value.
    if (schema !== null) {
      const fields: Record<string, unknown> = {};
      for (const spec of schema.fields) {
        if (spec.kind === 'table') continue;
        if (reset.includes(`fields.${spec.key}`)) continue;
        const field = draft.fields[spec.key];
        if (field === undefined) continue;
        const value = patchValueOf(field);
        // A half-written money is not a fact yet, and not a clearing either — it does not travel.
        if (value === undefined) continue;
        if (!sameFieldValue(value, extractedValues[spec.key])) fields[spec.key] = value;
      }
      if (Object.keys(fields).length > 0) change.fields = fields;
    }
    if (reset.length > 0) change.reset = reset;

    if (Object.keys(change).length > 0) onSave?.(change);
    stopEditing();
  };

  // E for edit, Escape to back out. 🔒 Ignored while anything typed into is holding the focus, or
  // typing an "e" into the city would turn into a command (docs/11 §11.5). The listener is on the
  // window, so this covers the title and the description being edited in place in the sidebar as
  // well as this pane's own inputs: a bare letter that opens a form while somebody is writing a
  // title is a bare letter that eats the title.
  useEffect(() => {
    // Nothing to open, so nothing listens: a bare "e" pressed over a document being looked at in a
    // peek must not open a form on it (docs/11 §11.5e).
    if (readOnly) return undefined;

    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Escape works from inside a field: leaving is what it is for. "e" does not — an "e" typed
      // into a city name has to stay an "e".
      if (event.key === 'Escape' && draft !== null) {
        stopEditing();
        return;
      }
      if (!typing && event.key.toLowerCase() === 'e' && draft === null) {
        event.preventDefault();
        startEditing();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Which step writes which field, for the rows of this section (above).
  const state = (...steps: DocumentStep[]): 'PENDING' | 'RUNNING' | undefined =>
    pendingState(document, steps);

  // "read as X" — shown only where the machine's answer and the current one differ, because
  // repeating a value that nobody changed is noise (docs/03 §3.3.10).
  //
  // Outside the form it is also the way back: one click resets the field to what was read, without
  // an edit session around it (docs/11 §11.5). Only where a reset exists — a person the analysis
  // named is a link, and PATCH has no reset for one — and only outside the form, where the control
  // beside the input already answers this.
  const wasRead = (
    auto: string | null | undefined,
    current: string,
    fields: DocumentResetEntry[] = [],
  ): ReactNode => {
    if (auto === null || auto === undefined || auto === '' || auto === current) return undefined;

    const text = t('viewer.details.auto', { value: auto });
    // In a peek it is a fact about the document and never a way back to it: what was read is worth
    // saying, and correcting somebody else's document from here is not on offer (docs/11 §11.5e).
    if (readOnly || editing || fields.length === 0) return text;

    return (
      <Tooltip title={t('viewer.details.applyRead')}>
        <Button
          size="small"
          type="link"
          className="legere-definition-note-action"
          disabled={saving}
          onClick={() => onSave?.({ reset: fields })}
        >
          {text}
        </Button>
      </Tooltip>
    );
  };

  // The control plus, when the pipeline read something this no longer matches, a way back to it.
  // The wrapper stands whether or not the button does: a tree that changed shape around the input
  // on the first diverging keystroke would remount it and eat the keys that follow.
  const withReset = (
    fields: DocumentResetEntry[],
    control: ReactNode,
    differs: boolean,
  ): ReactNode => (
    <div className="legere-field-with-reset">
      {control}
      {differs && !fields.some((field) => reset.includes(field)) && (
        <Button size="small" type="link" onClick={() => resetFields(fields)}>
          {t('viewer.details.reset')}
        </Button>
      )}
    </div>
  );

  // One key of the fields draft, replaced wholesale: each control writes its own kind back.
  const setFieldDraft = (key: string, value: FieldDraft): void => {
    setDraft((current) =>
      current === null ? current : { ...current, fields: { ...current.fields, [key]: value } },
    );
  };

  // The input a scalar kind edits in (docs/11 §11.5): a string is an Input, a number an
  // InputNumber, a date the same picker the documentDate row uses — and a money two inputs sharing
  // one width, amount and currency, because it is one fact.
  const fieldControl = (spec: DocumentFieldSpec, field: FieldDraft, label: string): ReactNode => {
    if (field.kind === 'number') {
      return (
        <InputNumber
          className="legere-field"
          aria-label={label}
          value={field.value}
          onChange={(value) =>
            setFieldDraft(spec.key, {
              kind: 'number',
              value: typeof value === 'number' ? value : null,
            })
          }
        />
      );
    }
    if (field.kind === 'date') {
      return (
        <DatePicker
          className="legere-field"
          aria-label={label}
          // Held as yyyy-mm-dd and only made a dayjs on the way into the picker, exactly as the
          // documentDate above: a Date would drag a time zone in with it.
          value={field.value === null ? null : dayjs(field.value)}
          onChange={(value) =>
            setFieldDraft(spec.key, {
              kind: 'date',
              value: value === null ? null : value.format('YYYY-MM-DD'),
            })
          }
        />
      );
    }
    if (field.kind === 'money') {
      return (
        <span className="legere-field legere-field-split">
          <InputNumber
            aria-label={label}
            value={field.amount}
            onChange={(value) =>
              setFieldDraft(spec.key, {
                ...field,
                amount: typeof value === 'number' ? value : null,
              })
            }
          />
          <Input
            aria-label={t('viewer.details.currency')}
            maxLength={3}
            value={field.currency}
            onChange={(event) =>
              setFieldDraft(spec.key, { ...field, currency: event.target.value.toUpperCase() })
            }
          />
        </span>
      );
    }
    return (
      <Input
        className="legere-field"
        aria-label={label}
        value={field.value}
        onChange={(event) => setFieldDraft(spec.key, { kind: 'string', value: event.target.value })}
      />
    );
  };

  // A `table` field as a small read-only table of its rows (docs/11 §11.5): columns from the spec,
  // headers localized like the field labels. Deliberately not editable in the form — re-reading the
  // document is how a table is corrected, and a row editor for receipt lines is a spreadsheet
  // nobody asked for.
  const fieldTable = (
    fieldSchema: DocumentFieldSchema,
    spec: DocumentFieldSpec,
    value: unknown,
  ): ReactNode => {
    const columns = spec.columns ?? [];
    const rows = !Array.isArray(value)
      ? []
      : value.flatMap((row, index) => (isRecord(row) ? [{ rowId: index, cells: row }] : []));
    if (rows.length === 0 || columns.length === 0) return '';
    return (
      <Table
        size="small"
        pagination={false}
        rowKey="rowId"
        dataSource={rows}
        columns={columns.map((column) => ({
          key: column.key,
          title: t(`viewer.fields.${fieldSchema.typeSlug}.${spec.key}Columns.${column.key}`),
          dataIndex: ['cells', column.key],
          // A cell the row does not carry says so the way every empty value here does.
          render: (cell: unknown) =>
            typeof cell === 'string' || typeof cell === 'number' ? cell : '—',
        }))}
      />
    );
  };

  // One row of the typed-fields group (docs/03 §3.3.10a, docs/11 §11.5): the label from the message
  // catalog (the registry carries none), the value formatted for the reader — and, for the scalar
  // kinds, the same Edit form, the same grey "read as …" line and the same way back that every
  // other corrected field has. Every row carries the `fields` step's badge while that step has not
  // settled, exactly as the place rows carry the analysis's.
  const typedFieldRow = (fieldSchema: DocumentFieldSchema, spec: DocumentFieldSpec) => {
    const label = t(`viewer.fields.${fieldSchema.typeSlug}.${spec.key}`);
    const current = extractedValues[spec.key];
    if (spec.kind === 'table') {
      return { label, value: fieldTable(fieldSchema, spec, current), pending: state('fields') };
    }

    const resetEntry = `fields.${spec.key}`;
    const autoShown = formatFieldValue(spec, document.auto.fields?.[spec.key]);
    const field = draft === null ? undefined : draft.fields[spec.key];

    return {
      label,
      value:
        field !== undefined
          ? withReset(
              [resetEntry],
              fieldControl(spec, field, label),
              autoShown !== '' && autoShown !== formatFieldValue(spec, patchValueOf(field)),
            )
          : formatFieldValue(spec, current),
      pending: state('fields'),
      note: wasRead(autoShown, formatFieldValue(spec, current), [resetEntry]),
    };
  };

  const autoType = documentTypes.find(
    (documentType) => documentType.slug === document.auto.typeSlug,
  );
  const autoLanguages = (document.auto.languages ?? []).map(displayLanguage).join(', ');
  const autoPlace = placeOf(document.auto.city ?? null, document.auto.country ?? null);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* 1. What it says — every row a machine read off the page, and the only section of the three
          anybody may correct (docs/11 §11.5). */}
      <Space
        direction="vertical"
        size="middle"
        className={editing ? 'legere-details-form is-editing' : 'legere-details-form'}
        style={{ width: '100%' }}
      >
        {/* 🔒 The Edit button stands in this section's own heading and not above the pane: a control
            belongs over the rows it acts on and over no others, and the two sections below hold
            nothing it could touch (docs/11 §11.5). */}
        <div className="legere-section-head">
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t('viewer.details.says')}
          </Typography.Title>
          {!readOnly && !editing && (
            <Tooltip title={t('viewer.details.editHint')}>
              <Button onClick={startEditing}>{t('common.actions.edit')}</Button>
            </Tooltip>
          )}
        </div>

        <DefinitionList
          items={[
            {
              label: t('viewer.details.documentType'),
              value:
                draft !== null ? (
                  withReset(
                    ['documentType'],
                    <Select
                      allowClear
                      className="legere-field"
                      placeholder={t('viewer.documentType')}
                      aria-label={t('viewer.documentType')}
                      value={draft.typeId ?? undefined}
                      onChange={(typeId?: string) => setDraft({ ...draft, typeId: typeId ?? null })}
                      options={documentTypes.map((documentType) => ({
                        value: documentType.id,
                        label: documentType.name,
                      }))}
                    />,
                    document.auto.typeSlug !== undefined &&
                      document.auto.typeSlug !== null &&
                      (autoType?.id ?? null) !== draft.typeId,
                  )
                ) : (
                  <Space size={4} wrap>
                    {/* The type is a folder that already has a screen of its own (docs/11 §11.4). */}
                    {document.documentType === null ? (
                      ''
                    ) : (
                      <Link href={`/browse/types/${document.documentType.id}`}>
                        {document.documentType.name}
                      </Link>
                    )}
                    {/* Chosen by the classifier and not confirmed by anybody since (03 §3.3.10). */}
                    {document.typeSource === 'AUTO' && <Tag color="blue">{t('viewer.auto')}</Tag>}
                  </Space>
                ),
              pending: state('analysis'),
              note: wasRead(
                autoType?.name ?? document.auto.typeSlug,
                document.documentType?.name ?? '',
                ['documentType'],
              ),
            },
            {
              label: t('viewer.details.people'),
              value:
                draft !== null ? (
                  <Select
                    mode="multiple"
                    className="legere-field"
                    optionFilterProp="label"
                    placeholder={t('viewer.details.peoplePlaceholder')}
                    aria-label={t('viewer.details.people')}
                    value={draft.peopleIds}
                    searchValue={search}
                    onSearch={setSearch}
                    onChange={(peopleIds: string[]) => setDraft({ ...draft, peopleIds })}
                    // A name the catalogue no longer holds stays here so it can be seen and taken
                    // off, and cannot be put back on — which is what 03 §3.3.19 means when it says
                    // only new documents stop being able to name it.
                    options={personOptions.map((person) => ({
                      value: person.id,
                      label: person.name,
                      disabled: person.deleted,
                    }))}
                    optionRender={(option) => nameOrRecord(option.label, option.data.disabled)}
                    labelRender={(label) =>
                      nameOrRecord(label.label, isDeleted(personOptions, label.value))
                    }
                    // A name the catalogue does not have yet is added to it: the analyst does exactly
                    // that on its own, and whoever corrects it must not need an admin (03 §3.3.19).
                    popupRender={(menu) => (
                      <>
                        {menu}
                        {isNewName(search, people) && (
                          <Button
                            type="link"
                            block
                            onClick={() => {
                              const name = search.trim();
                              setSearch('');
                              void onCreatePerson?.(name)?.then((personId) =>
                                setDraft((current) =>
                                  current === null
                                    ? current
                                    : { ...current, peopleIds: [...current.peopleIds, personId] },
                                ),
                              );
                            }}
                          >
                            {t('viewer.details.addPerson', { name: search.trim() })}
                          </Button>
                        )}
                      </>
                    )}
                  />
                ) : (
                  joinNames(
                    document.people.map((person) => ({
                      id: person.id,
                      node: wayIn(person.name, `/browse/people/${person.id}`, person.deleted),
                    })),
                  )
                ),
              pending: state('analysis'),
              note: wasRead(
                (document.auto.people ?? []).join(', '),
                document.people.map((person) => person.name).join(', '),
              ),
            },
            {
              // A kind is not an object, so it is not printed as one (docs/11 §11.5). The row above
              // says what sort of thing this document is about; the row below says which one. Editing
              // stays a single control over subjects — a subject *is* a kind plus a name, and choosing
              // the two apart would let somebody choose a pair that is not a row — so here the kinds
              // simply follow what the select holds.
              label: t('viewer.details.subjectKinds'),
              value: joinNames(
                kinds.map((subjectKind) => ({
                  id: subjectKind.id,
                  // Not a browse screen: `/browse/subjects/:kind` lists the *things* of a kind, and
                  // what is wanted here is the documents. The home screen carries the filter in its
                  // URL, which is where filters live (docs/11 §11.3).
                  node:
                    draft !== null ? (
                      subjectKind.name
                    ) : (
                      <Link href={documentsHref({ subjectKindId: subjectKind.id })}>
                        {subjectKind.name}
                      </Link>
                    ),
                })),
              ),
              pending: state('analysis'),
              note: wasRead(
                distinctKinds(document.auto.subjects ?? []),
                kinds.map((subjectKind) => subjectKind.name).join(', '),
              ),
            },
            {
              label: t('viewer.details.subjects'),
              value:
                draft !== null ? (
                  <Select
                    mode="multiple"
                    className="legere-field"
                    optionFilterProp="label"
                    placeholder={t('viewer.details.subjectsPlaceholder')}
                    aria-label={t('viewer.details.subjects')}
                    value={draft.subjectIds}
                    searchValue={subjectSearch}
                    onSearch={setSubjectSearch}
                    onChange={(subjectIds: string[]) => setDraft({ ...draft, subjectIds })}
                    options={subjectOptions.map((subject) => ({
                      value: subject.id,
                      label: `${subject.name} · ${subject.kind}`,
                      disabled: subject.deleted,
                    }))}
                    optionRender={(option) => nameOrRecord(option.label, option.data.disabled)}
                    labelRender={(label) =>
                      nameOrRecord(label.label, isDeleted(subjectOptions, label.value))
                    }
                    // Adding one takes both halves — a name with no kind is not a thing anybody can
                    // file by — so the footer asks for the kind before it offers to add (03 §3.3.20).
                    popupRender={(menu) => (
                      <>
                        {menu}
                        {subjectSearch.trim() !== '' && (
                          <Space.Compact style={{ width: '100%', padding: 4 }}>
                            <AutoComplete
                              style={{ width: '45%' }}
                              value={kind}
                              onChange={setKind}
                              placeholder={t('viewer.details.subjectKind')}
                              // The catalogue of kinds, not the kinds that happen to be in use: a kind
                              // with nothing in it yet is still one to file under (docs/03 §3.3.20a).
                              options={subjectKinds.map((subjectKind) => ({
                                value: subjectKind.name,
                              }))}
                            />
                            <Button
                              type="primary"
                              disabled={kind.trim() === ''}
                              onClick={() => {
                                const name = subjectSearch.trim();
                                const chosenKind = kind.trim();
                                setSubjectSearch('');
                                setKind('');
                                void onCreateSubject?.(chosenKind, name)?.then((subjectId) =>
                                  setDraft((current) =>
                                    current === null
                                      ? current
                                      : {
                                          ...current,
                                          subjectIds: [...current.subjectIds, subjectId],
                                        },
                                  ),
                                );
                              }}
                            >
                              {t('viewer.details.addSubject', { name: subjectSearch.trim() })}
                            </Button>
                          </Space.Compact>
                        )}
                      </>
                    )}
                  />
                ) : (
                  joinNames(
                    document.subjects.map((subject) => ({
                      id: subject.id,
                      // The thing itself, without its kind trailing after it: the row above carries
                      // that. `/browse/subjects/:kind/:id` is the shelf this thing already has.
                      node: wayIn(
                        subject.name,
                        `/browse/subjects/${subject.kindId}/${subject.id}`,
                        subject.deleted,
                      ),
                    })),
                  )
                ),
              pending: state('analysis'),
              note: wasRead(
                (document.auto.subjects ?? []).map((subject) => subject.name).join(', '),
                document.subjects.map((subject) => subject.name).join(', '),
              ),
            },
            {
              label: t('viewer.details.documentDate'),
              value:
                draft !== null ? (
                  withReset(
                    ['documentDate'],
                    <DatePicker
                      className="legere-field"
                      aria-label={t('viewer.details.documentDate')}
                      // The value is a calendar day, so it is held as yyyy-mm-dd and only becomes a
                      // dayjs on the way into the picker: a Date would drag a time zone in with it.
                      value={draft.documentDate === null ? null : dayjs(draft.documentDate)}
                      onChange={(value) =>
                        setDraft({
                          ...draft,
                          documentDate: value === null ? null : value.format('YYYY-MM-DD'),
                        })
                      }
                    />,
                    document.auto.date !== undefined && document.auto.date !== draft.documentDate,
                  )
                ) : // The whole day is the link, and it leads to its year: that is the folder the
                // archive is arranged into, and it already has a screen (docs/11 §11.4).
                yearOf(document.documentDate) === null ? (
                  formatDate(document.documentDate)
                ) : (
                  <Link href={`/browse/years/${yearOf(document.documentDate) ?? ''}`}>
                    {formatDate(document.documentDate)}
                  </Link>
                ),
              pending: state('analysis'),
              note: wasRead(document.auto.date, document.documentDate ?? '', ['documentDate']),
            },
            {
              label: t('viewer.details.pageFormat'),
              // The one field here that is an instruction rather than a correction: the format is read
              // while the pages are made, and they are made already (docs/05 §5.5 step 1). So saving it
              // changes what the next build will do and nothing about the document on screen.
              value:
                draft !== null ? (
                  <Select
                    className="legere-field"
                    aria-label={t('viewer.details.pageFormat')}
                    value={draft.pageFormat}
                    onChange={(value: PageFormat) => setDraft({ ...draft, pageFormat: value })}
                    options={PAGE_FORMATS.map((value) => ({
                      value,
                      label: t(`viewer.details.pageFormats.${value}`),
                    }))}
                  />
                ) : (
                  t(`viewer.details.pageFormats.${document.pageFormat}`)
                ),
              pending: state('canonical'),
              // 🔒 Said where it is being decided, and only once the choice differs from what the
              // document holds: a new format is an instruction for the next build, so the pages keep
              // the shape they have until somebody asks for them again (docs/11 §11.5). A warning
              // rather than a rebuild — remaking forty pages and recognising their text afresh is not
              // something a metadata form gets to start on its own.
              note:
                draft !== null && draft.pageFormat !== document.pageFormat ? (
                  <Typography.Text type="warning">
                    {t('viewer.details.pageFormatRebuild')}
                  </Typography.Text>
                ) : undefined,
            },
            {
              label: t('viewer.details.languages'),
              // Free-form on purpose: BCP-47 has more tags than any list worth shipping, and the ones
              // already on the document are offered with their names spelled out.
              value:
                draft !== null
                  ? withReset(
                      ['languages'],
                      <Select
                        mode="tags"
                        className="legere-field"
                        // Searched by the name, not by the value: "Rus" has to find "Russian (ru)",
                        // which is the whole point of offering the list (docs/11 §11.5).
                        optionFilterProp="label"
                        placeholder={t('viewer.details.languagesPlaceholder')}
                        aria-label={t('viewer.details.languages')}
                        value={draft.languages}
                        onChange={(languages: string[]) => setDraft({ ...draft, languages })}
                        options={languageOptions(document.languages, document.auto.languages ?? [])}
                      />,
                      (document.auto.languages ?? []).join('|') !== draft.languages.join('|') &&
                        (document.auto.languages ?? []).length > 0,
                    )
                  : document.languages.map(displayLanguage).join(', '),
              pending: state('markdown', 'analysis'),
              note: wasRead(autoLanguages, document.languages.map(displayLanguage).join(', '), [
                'languages',
              ]),
            },
            {
              label: t('viewer.details.place'),
              value:
                draft !== null
                  ? withReset(
                      // A place is one fact written in two boxes: putting it back has to put both
                      // back, or a reset city would keep somebody's country.
                      ['city', 'country'],
                      <span className="legere-field legere-field-split">
                        <Input
                          placeholder={t('viewer.details.cityPlaceholder')}
                          aria-label={t('viewer.details.city')}
                          value={draft.city}
                          onChange={(event) => setDraft({ ...draft, city: event.target.value })}
                        />
                        <Select
                          showSearch
                          allowClear
                          optionFilterProp="label"
                          placeholder={t('viewer.details.countryPlaceholder')}
                          aria-label={t('viewer.details.country')}
                          value={draft.country ?? undefined}
                          onChange={(country?: string) =>
                            setDraft({ ...draft, country: country ?? null })
                          }
                          options={COUNTRY_OPTIONS}
                        />
                      </span>,
                      autoPlace !== '' &&
                        autoPlace !==
                          placeOf(
                            draft.city.trim() === '' ? null : draft.city.trim(),
                            draft.country,
                          ),
                    )
                  : joinNames(placeWaysIn(document.city, document.country)),
              pending: state('analysis'),
              // One fact in two boxes, so putting it back puts both back — a reset city that kept
              // somebody's country would be a place that was never read anywhere.
              note: wasRead(autoPlace, placeOf(document.city, document.country), [
                'city',
                'country',
              ]),
            },
          ]}
        />

        {/* The typed fields close this section, under the rows above (docs/11 §11.5): a group per
            the document's field schema, one row per field in schema order, drawn only where the type
            carries a schema at all (docs/03 §3.3.10a). */}
        {schema !== null && (
          <DefinitionList items={schema.fields.map((spec) => typedFieldRow(schema, spec))} />
        )}

        {/* Save ends what Edit started, so it sits at the other end of the same section and on the
            same side: the eye leaves a form at its bottom-right corner (docs/11 §11.5). */}
        {editing && (
          <div className="legere-form-actions">
            <Space>
              <Button onClick={stopEditing}>{t('common.actions.cancel')}</Button>
              <Button type="primary" loading={saving} onClick={save}>
                {t('common.actions.save')}
              </Button>
            </Space>
          </div>
        )}
      </Space>

      {/* 2. What it is — the artifact rather than the reading (docs/11 §11.5). */}
      <WhatItIsSection document={document} />

      {/* 3. What it cost — what the pipeline spent getting here. The journal has one line per
          moment and this is the same numbers read the other way round, by step, because "how long
          did the text take, and did it read anything" is a question about the document, not about
          the log (docs/03 §3.3.18, docs/11 §11.5). */}
      <StepCostSection documentId={document.id} />
    </Space>
  );
}

// 2. What it is: size, pages, added, OCR used — the facts of the artifact, which nobody may correct
// and no form here edits (docs/11 §11.5). Two of them are still being counted while the pipeline
// runs, so they carry their step's badge exactly as the read rows above do — a badge says a number
// is on its way, not that somebody may choose it.
//
// 🔒 A component of its own, memoized on the document it describes, so that opening the form above
// leaves it alone: the Edit button acts on the section it stands in, and a section with nothing to
// edit should not re-render because a draft changed somewhere else.
const WhatItIsSection = memo(function WhatItIsSection({
  document,
}: {
  document: DocumentDetailDto;
}) {
  const t = useTranslations();
  const size = useMemo(() => formatBytes(document.sizeBytes), [document.sizeBytes]);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t('viewer.details.is')}
      </Typography.Title>

      <DefinitionList
        items={[
          { label: t('viewer.details.size'), value: size, emphasis: true },
          {
            label: t('viewer.details.pages'),
            value: document.pageCount,
            emphasis: true,
            pending: pendingState(document, ['preview']),
          },
          {
            label: t('viewer.details.created'),
            value: new Date(document.createdAt).toLocaleString(),
          },
          ...(document.createdBy === null
            ? []
            : [
                {
                  label: t('identity.creator'),
                  value: (
                    <UserAttribution
                      name={document.createdBy.displayName}
                      agent={document.createdVia}
                    />
                  ),
                },
              ]),
          {
            label: t('viewer.details.ocr'),
            value: document.ocrUsed ? t('common.yes') : t('common.no'),
            pending: pendingState(document, ['markdown']),
          },
        ]}
      />
    </Space>
  );
});

// 3. What it cost: one row per step, the newest run only — a step re-run three times has three
// entries in the log and one truthful answer here (docs/03 §3.3.18, docs/11 §11.5). Only the numbers
// that step actually reported: 🔒 a missing number is not a zero, it means that step does not answer
// that question — so a step that answered none of them has no row, and a document nothing has
// finished on yet has no section.
//
// Memoized on the document id, like the section above it, so that opening the form in **What it
// says** does not re-render a table the form cannot touch.
const StepCostSection = memo(function StepCostSection({ documentId }: { documentId: string }) {
  const t = useTranslations();
  // The same query the Log tab uses, so opening both costs one request (docs/10 §10.4).
  const events = useDocumentEvents(documentId);

  const latest = new Map<string, DocumentEventDto>();
  for (const event of events.data?.pages.flatMap((page) => page.items) ?? []) {
    const step = event.payload.step;
    // The list arrives newest first, so the first entry seen for a step is its latest run.
    if (event.type === 'STEP_FINISHED' && step !== undefined && !latest.has(step)) {
      latest.set(step, event);
    }
  }

  const rows = DOCUMENT_STEPS.flatMap((step) => {
    const event = latest.get(step);
    if (event === undefined) return [];
    const cost = stepCost(event, t);
    return cost.length === 0 ? [] : [{ step, cost: cost.join(' · ') }];
  });

  if (rows.length === 0) return null;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t('viewer.details.cost')}
      </Typography.Title>

      <DefinitionList
        items={rows.map((row) => ({
          label: t(`viewer.steps.${row.step}`),
          value: row.cost,
        }))}
      />
    </Space>
  );
});
