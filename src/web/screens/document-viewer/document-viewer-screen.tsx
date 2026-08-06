'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DownOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import {
  App,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  List,
  Row,
  Select,
  Space,
  Spin,
  Tabs,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { DefinitionList } from '../../shared/ui/definition-list';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  DOCUMENT_STEPS,
  type ResettableField,
  type DocumentDetailDto,
  type DocumentEventDto,
  type DocumentFileDto,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import type { StepStatus } from '../../../shared/contracts/enums';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { documentApi, documentFiles, documentKeys } from '../../entities/document';
import { personApi, personKeys } from '../../entities/person';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { CropEditor } from '../../features/crop-editor';
import { UploadButton, UploadingRow, useDocumentUpload } from '../../features/document-upload';
import { useErrorMessage, formatBytes } from '../../shared/lib';
import { isViewerTab, type ViewerTab } from './viewer-tab';

// The viewer refreshes while the pipeline is still working on this document (docs/10 §10.5).
const LIVE_REFRESH_MS = 5000;

// /documents/:id (docs/11 §11.5): read the document, and manage the little that belongs to it.
export function DocumentViewerScreen({
  id,
  tab = 'preview',
  isAdmin = false,
}: {
  id: string;
  tab?: ViewerTab;
  isAdmin?: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  // The address is the source of truth, but the tab switches on the click rather than after the
  // navigation: a tab that waits for the router to come back feels broken.
  const [active, setActive] = useState<ViewerTab>(tab);
  useEffect(() => setActive(tab), [tab]);
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const document = useQuery({
    queryKey: documentKeys.detail(id),
    queryFn: () => documentApi.get(id),
    refetchInterval: (query) => (query.state.data?.processing === true ? LIVE_REFRESH_MS : false),
  });

  const markdown = useQuery({
    queryKey: documentKeys.markdown(id),
    queryFn: () => documentApi.markdown(id),
    enabled: document.data !== undefined,
  });

  // The document itself is polled while the pipeline works on it, so Details keeps up on its own.
  // The text and the log live on their own queries and would sit there stale, showing "being
  // extracted" over a document that finished a minute ago (docs/10 §10.5). Rather than polling them
  // too, they are refetched when a step changes state: that is the only moment either can change,
  // and it is already being watched.
  const stepsKey = JSON.stringify(document.data?.steps ?? {});
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(id) });
  }, [stepsKey, id, queryClient]);

  const documentTypes = useQuery({ queryKey: documentTypeKeys.all, queryFn: documentTypeApi.list });
  const collections = useQuery({ queryKey: collectionKeys.all, queryFn: collectionApi.list });
  const people = useQuery({ queryKey: personKeys.all, queryFn: personApi.list });
  const subjects = useQuery({ queryKey: subjectKeys.all, queryFn: subjectApi.list });
  const subjectKinds = useQuery({ queryKey: subjectKindKeys.all, queryFn: subjectKindApi.list });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(id) });
  };

  const update = useMutation({
    mutationFn: (input: MetaChange) => documentApi.update(id, input),
    onSuccess: () => {
      void message.success(t('viewer.saved'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const addToCollection = useMutation({
    mutationFn: (collectionId: string) => collectionApi.addItem(collectionId, id),
    onSuccess: () => {
      void message.success(t('viewer.addedToCollection'), 2);
      void queryClient.invalidateQueries({ queryKey: collectionKeys.all });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const [steps, setSteps] = useState<DocumentStep[]>([]);
  const reprocess = useMutation({
    mutationFn: () => documentApi.reprocess(id, steps.length === 0 ? {} : { steps }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      setSteps([]);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  if (document.isPending) return <Spin />;
  if (document.data === undefined) return <Empty description={t('errors.codes.NOT_FOUND')} />;

  const detail = document.data;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={16}>
        {/* Above the document, not beside it: the title names what is on this page, and a name is
            read before its metadata (docs/11 §11.5). */}
        <Typography.Title
          level={3}
          style={{ marginTop: 0 }}
          editable={{
            onChange: (title) => {
              if (title.trim() !== '' && title !== detail.title) update.mutate({ title });
            },
            triggerType: ['icon', 'text'],
          }}
        >
          {detail.title}
        </Typography.Title>

        {/* What this document is, for somebody who has never seen it — under the name, before the
            tabs, because it is the thing that decides whether the rest is worth opening
            (docs/11 §11.5). Written by the analysis where nobody has written one, and editable in
            place like the title. */}
        {(detail.description !== null || update.isPending) && (
          <Typography.Paragraph
            type="secondary"
            style={{ maxWidth: '60ch' }}
            editable={{
              onChange: (description) => {
                const next = description.trim() === '' ? null : description.trim();
                if (next !== detail.description) update.mutate({ description: next });
              },
              triggerType: ['icon', 'text'],
              autoSize: { minRows: 2, maxRows: 8 },
            }}
          >
            {detail.description ?? ''}
          </Typography.Paragraph>
        )}

        {/* What the analysis would have called it, when somebody has since called it something else
            — under the name, in the same place every other correction keeps its provenance, and a
            click away from being the name (docs/11 §11.5). */}
        {detail.auto.title !== undefined && detail.auto.title !== detail.title && (
          <div className="legere-definition-note" style={{ marginTop: -12, marginBottom: 16 }}>
            <Tooltip title={t('viewer.details.applyRead')}>
              <Button
                size="small"
                type="link"
                className="legere-definition-note-action"
                disabled={update.isPending}
                onClick={() => update.mutate({ reset: ['title'] })}
              >
                {t('viewer.details.auto', { value: detail.auto.title })}
              </Button>
            </Tooltip>
          </div>
        )}

        <Card>
          <Tabs
            activeKey={active}
            // `replace`, not `push`: reading a document is one visit, and three tabs should not cost
            // three presses of the browser's back button to leave.
            onChange={(key) => {
              if (!isViewerTab(key)) return;
              setActive(key);
              router.replace(`/documents/${id}/${key}`);
            }}
            items={[
              {
                key: 'preview',
                label: t('viewer.tabs.preview'),
                children: <PreviewPane document={detail} />,
              },
              {
                key: 'text',
                label: t('viewer.tabs.text'),
                children: (
                  <TextPane
                    document={detail}
                    markdown={markdown.data?.markdown ?? null}
                    loading={markdown.isPending}
                  />
                ),
              },
              {
                key: 'log',
                label: t('viewer.tabs.log'),
                children: (
                  <LogPane id={id} active={active === 'log'} processing={detail.processing} />
                ),
              },
              {
                key: 'details',
                label: t('viewer.tabs.details'),
                children: (
                  <DetailsPane
                    document={detail}
                    documentTypes={documentTypes.data?.items ?? []}
                    people={people.data?.items ?? []}
                    subjects={subjects.data?.items ?? []}
                    subjectKinds={subjectKinds.data?.items ?? []}
                    // A kind is a row now (docs/03 §3.3.20a), and one the catalogue has never seen
                    // is created here rather than refused: the person filing a boat should not have
                    // to go and invent "boat" somewhere else first.
                    onCreateSubject={async (kind, name) => {
                      const wanted = kind.trim().toLowerCase();
                      const known = (subjectKinds.data?.items ?? []).find(
                        (candidate) => candidate.name.toLowerCase() === wanted,
                      );
                      const kindId =
                        known?.id ?? (await subjectKindApi.create({ name: wanted })).id;
                      const created = await subjectApi.create({ kindId, name });
                      await Promise.all([
                        queryClient.invalidateQueries({ queryKey: subjectKeys.all }),
                        queryClient.invalidateQueries({ queryKey: subjectKindKeys.all }),
                      ]);
                      return created.id;
                    }}
                    onCreatePerson={async (name) => {
                      const created = await personApi.create({ name });
                      await queryClient.invalidateQueries({ queryKey: personKeys.all });
                      return created.id;
                    }}
                    onSave={(input) => update.mutate(input)}
                    saving={update.isPending}
                  />
                ),
              },
            ]}
          />
        </Card>
      </Col>

      <Col xs={24} lg={8}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <DownloadSplitButton document={detail} />

              {/* Only the caller's own collections: adding to somebody else's is not a thing a
                  reader may do (docs/03 §3.4). */}
              <Select
                showSearch
                optionFilterProp="label"
                style={{ width: '100%' }}
                placeholder={t('viewer.addToCollection')}
                aria-label={t('viewer.addToCollection')}
                loading={collections.isPending}
                value={null}
                onChange={(collectionId: string) => addToCollection.mutate(collectionId)}
                options={(collections.data?.items ?? [])
                  .filter((collection) => collection.mine)
                  .map((collection) => ({ value: collection.id, label: collection.name }))}
              />
            </Space>
          </Card>

          <Card title={t('viewer.processing.title')} size="small">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* One row per step: pick it, see its state, read what happened to it. A grid rather
                  than stacked rows because the status tags have different widths — laid out
                  independently, every label would start at a different place (docs/11 §11.5). */}
              <div className={`legere-steps${isAdmin ? ' has-select' : ''}`}>
                {DOCUMENT_STEPS.map((step) => {
                  const reason = detail.skipReasons[step];
                  const label = t(`viewer.steps.${step}`);
                  const failure = detail.failedStep === step ? detail.processingError : null;
                  return (
                    <Fragment key={step}>
                      {isAdmin && (
                        <Checkbox
                          aria-label={label}
                          checked={steps.includes(step)}
                          onChange={(event) =>
                            setSteps((chosen) =>
                              event.target.checked
                                ? [...chosen, step]
                                : chosen.filter((other) => other !== step),
                            )
                          }
                        />
                      )}
                      <Tag color={statusColor(detail.steps[step])}>{detail.steps[step]}</Tag>
                      <Typography.Text>{label}</Typography.Text>
                      {/* SKIPPED alone reads like a failure; the reason says which harmless one it
                          was, and whether it is something an admin can change (docs/03 §3.3.10). */}
                      {reason !== undefined && (
                        <Typography.Text type="secondary" className="legere-step-note">
                          {t(`viewer.skipReasons.${reason}`)}
                        </Typography.Text>
                      )}
                      {failure !== null && (
                        <Typography.Text type="danger" className="legere-step-note">
                          {failure}
                        </Typography.Text>
                      )}
                    </Fragment>
                  );
                })}
              </div>

              {/* A failure the server could not attribute to a step still has to be readable. */}
              {detail.processingError !== null && detail.failedStep === null && (
                <Typography.Text type="danger" style={{ whiteSpace: 'pre-wrap' }}>
                  {detail.processingError}
                </Typography.Text>
              )}

              {isAdmin && (
                <Button onClick={() => reprocess.mutate()} loading={reprocess.isPending}>
                  {steps.length === 0
                    ? t('viewer.processing.reprocessAll')
                    : t('viewer.processing.reprocessSelected', { count: steps.length })}
                </Button>
              )}
            </Space>
          </Card>
        </Space>
      </Col>
    </Row>
  );
}

// The document itself, as the browser can show it (docs/10 §10.8): **the canonical PDF**, whatever
// the document happens to be made of — by the time it is readable it is a PDF (docs/05 §5.5). Until
// that step has finished there is nothing whole to show, so the pane is honest about it rather than
// quietly showing page one of forty (docs/11 §11.5).
function PreviewPane({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();

  if (document.steps.canonical === 'DONE') {
    return (
      <object
        // Keyed by the step that produces it: a canonical requested before it existed is a dead
        // embed the browser will never retry on its own (docs/10 §10.5).
        key={document.steps.canonical}
        data={documentFiles.canonical(document.id)}
        type="application/pdf"
        style={{ width: '100%', height: '70vh' }}
        aria-label={t('viewer.tabs.preview')}
      >
        {/* Whatever the browser cannot render inline, it can still download. */}
        <a href={documentFiles.canonical(document.id, { download: true })}>
          {t('viewer.download')}
        </a>
      </object>
    );
  }

  // The first page, while the whole of it is still being put together — with a line saying that is
  // what this is, so nobody reads a one-page preview as the whole document.
  if (document.hasPreview) {
    return (
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('viewer.canonical.assembling')}</Typography.Text>
        {/* eslint-disable-next-line @next/next/no-img-element -- an API route that 302s to a signed URL. */}
        <img
          key={document.steps.preview}
          src={documentFiles.preview(document.id)}
          alt={document.title}
          style={{ maxWidth: '100%' }}
        />
      </Space>
    );
  }

  return (
    <Empty
      description={
        document.steps.canonical === 'FAILED'
          ? t('viewer.canonical.failed')
          : t('viewer.canonical.assembling')
      }
    />
  );
}

// Download is a split button (docs/11 §11.5b): its main half is the document as one piece, its
// dropdown the originals it was made of. The default is never silently an original — a document made
// of forty photographs downloads as one PDF, and whoever wants photograph 23 asks for it by name.
function DownloadSplitButton({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const ready = document.steps.canonical === 'DONE';

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Tooltip title={ready ? undefined : t('viewer.canonical.assembling')}>
        {/* antd drops the href of a disabled button, so there is nothing left to click through to
            while the document is not one piece yet (docs/11 §11.5b). */}
        <Button
          type="primary"
          block
          disabled={!ready}
          {...(ready ? { href: documentFiles.canonical(document.id, { download: true }) } : {})}
        >
          {t('viewer.download')}
        </Button>
      </Tooltip>
      {/* Enabled even while the canonical is not: the dropdown is the answer to "I need the raw
          file", and it has to work on the worst day (docs/11 §11.5b). */}
      <Dropdown
        trigger={['click']}
        menu={{
          items: document.files.map((file) => ({
            key: file.id,
            disabled: !file.available,
            label: file.available ? (
              <a href={documentFiles.fileContent(document.id, file.id)} download={file.name}>
                {file.name}
              </a>
            ) : (
              <Space size={4}>
                <span>{file.name}</span>
                <Typography.Text type="secondary">
                  {t('viewer.files.missingReason')}
                </Typography.Text>
              </Space>
            ),
          })),
        }}
      >
        <Button type="primary" aria-label={t('viewer.downloadOriginals')} icon={<DownOutlined />} />
      </Dropdown>
    </Space.Compact>
  );
}

function TextPane({
  document,
  markdown,
  loading,
}: {
  document: DocumentDetailDto;
  markdown: string | null;
  loading: boolean;
}) {
  const t = useTranslations();

  if (loading) return <Spin />;
  if (markdown === null || markdown === '') {
    return (
      <Empty
        description={
          document.steps.markdown === 'FAILED'
            ? t('viewer.textFailed')
            : document.steps.markdown === 'RUNNING' || document.steps.markdown === 'PENDING'
              ? t('viewer.textPending')
              : t('viewer.noText')
        }
      />
    );
  }
  return <RenderedMarkdown markdown={markdown} />;
}

// 🔒 Extracted text is untrusted content: raw HTML never passes through (docs/10 §10.8).
//
// Typeset rather than merely rendered (docs/11 §11.5): the rhythm, the tables and the code all come
// from `.legere-prose`, so this stays a document being read rather than a browser's idea of one.
function RenderedMarkdown({ markdown }: { markdown: string }) {
  return (
    <Typography className="legere-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          // A table gets a scroller of its own: a fourteen-column invoice must not widen the pane,
          // and the columns must not be squeezed into it either.
          table: ({ node: _node, ...props }) => (
            <div className="legere-prose-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </Typography>
  );
}

type MetaChange = {
  title?: string;
  description?: string | null;
  typeId?: string | null;
  languages?: string[];
  country?: string | null;
  city?: string | null;
  peopleIds?: string[];
  subjectIds?: string[];
  documentDate?: string | null;
  reset?: ResettableField[];
};

// What a person may correct, while they are correcting it. Held apart from the document so that
// nothing is sent until Save: a select that writes on every keystroke turns a glance into an edit.
type Draft = {
  typeId: string | null;
  peopleIds: string[];
  subjectIds: string[];
  documentDate: string | null;
  languages: string[];
  country: string | null;
  city: string;
};

// Everything about the document that is not the document, in one list: what the file is, what the
// pipeline made of it, where its bytes live — and, behind an Edit button, a way to correct the parts
// a machine guessed (docs/11 §11.5).
function DetailsPane({
  document,
  documentTypes,
  people,
  onCreatePerson,
  subjects,
  subjectKinds,
  onCreateSubject,
  onSave,
  saving,
}: {
  document: DocumentDetailDto;
  documentTypes: Array<{ id: string; slug: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  onCreatePerson: (name: string) => Promise<string>;
  subjects: Array<{ id: string; kind: string; name: string }>;
  subjectKinds: Array<{ id: string; name: string }>;
  onCreateSubject: (kind: string, name: string) => Promise<string>;
  onSave: (input: MetaChange) => void;
  saving: boolean;
}) {
  const t = useTranslations();
  const size = useMemo(() => formatBytes(document.sizeBytes), [document.sizeBytes]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState('');
  const [subjectSearch, setSubjectSearch] = useState('');
  const [kind, setKind] = useState('');
  const [reset, setReset] = useState<ResettableField[]>([]);
  const editing = draft !== null;

  const startEditing = (): void => {
    setReset([]);
    setDraft({
      typeId: document.documentType?.id ?? null,
      peopleIds: document.people.map((person) => person.id),
      subjectIds: document.subjects.map((subject) => subject.id),
      documentDate: document.documentDate,
      languages: document.languages,
      country: document.country,
      city: document.city ?? '',
    });
  };

  const stopEditing = (): void => {
    setDraft(null);
    setReset([]);
  };

  // "Put it back to what was read." The draft shows the machine's value immediately; the server is
  // told it was a reset rather than a choice, so a reset documentType becomes AUTO again and the next
  // run may classify it (docs/03 §3.3.10).
  const resetFields = (fields: ResettableField[]): void => {
    if (draft === null) return;
    setReset((chosen) => [...new Set([...chosen, ...fields])]);
    const next = { ...draft };
    if (fields.includes('documentType')) next.typeId = autoType?.id ?? null;
    if (fields.includes('languages')) next.languages = document.auto.languages ?? [];
    if (fields.includes('country')) next.country = document.auto.country ?? null;
    if (fields.includes('city')) next.city = document.auto.city ?? '';
    if (fields.includes('documentDate')) next.documentDate = document.auto.date ?? null;
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
    if (reset.length > 0) change.reset = reset;

    if (Object.keys(change).length > 0) onSave(change);
    stopEditing();
  };

  // E for edit, Escape to back out. Ignored while a field has focus, or typing an "e" into the city
  // would turn into a command (docs/11 §11.5).
  useEffect(() => {
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

  // Which step writes which field (docs/05 §5.5): the page count comes with the preview, the text
  // and the languages with the parse, the place and the documentType with the AI step. A field whose
  // step has not settled is a field whose value is provisional, and it says so rather than showing
  // an em dash that reads as "there is none".
  const state = (...steps: DocumentStep[]): 'PENDING' | 'RUNNING' | undefined => {
    const statuses = steps.map((step) => document.steps[step]);
    if (statuses.includes('RUNNING')) return 'RUNNING';
    return statuses.includes('PENDING') ? 'PENDING' : undefined;
  };

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
    fields: ResettableField[] = [],
  ): ReactNode => {
    if (auto === null || auto === undefined || auto === '' || auto === current) return undefined;

    const text = t('viewer.details.auto', { value: auto });
    if (editing || fields.length === 0) return text;

    return (
      <Tooltip title={t('viewer.details.applyRead')}>
        <Button
          size="small"
          type="link"
          className="legere-definition-note-action"
          disabled={saving}
          onClick={() => onSave({ reset: fields })}
        >
          {text}
        </Button>
      </Tooltip>
    );
  };

  // The control plus, when the pipeline read something this no longer matches, a way back to it.
  const withReset = (fields: ResettableField[], control: ReactNode, differs: boolean): ReactNode =>
    differs && !fields.some((field) => reset.includes(field)) ? (
      <Space size={4} wrap>
        {control}
        <Button size="small" type="link" onClick={() => resetFields(fields)}>
          {t('viewer.details.reset')}
        </Button>
      </Space>
    ) : (
      control
    );

  const autoType = documentTypes.find(
    (documentType) => documentType.slug === document.auto.typeSlug,
  );
  const autoLanguages = (document.auto.languages ?? []).map(displayLanguage).join(', ');
  const autoPlace = placeOf(document.auto.city ?? null, document.auto.country ?? null);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* Above the list and to the right, where a form's own control belongs: it acts on everything
          below it, and it must not be hunted for at the end of a long list (docs/11 §11.5). */}
      <div className="legere-form-actions">
        {!editing && (
          <Tooltip title={t('viewer.details.editHint')}>
            <Button onClick={startEditing}>{t('common.actions.edit')}</Button>
          </Tooltip>
        )}
      </div>

      <DefinitionList
        items={[
          { label: t('viewer.details.size'), value: size, emphasis: true },
          {
            label: t('viewer.details.pages'),
            value: document.pageCount,
            emphasis: true,
            pending: state('preview'),
          },
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
                  {document.documentType?.name ?? ''}
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
                  options={people.map((person) => ({ value: person.id, label: person.name }))}
                  // A name the catalogue does not have yet is added to it: the analyst does exactly
                  // that on its own, and whoever corrects it must not need an admin (03 §3.3.19).
                  dropdownRender={(menu) => (
                    <>
                      {menu}
                      {isNewName(search, people) && (
                        <Button
                          type="link"
                          block
                          onClick={() => {
                            const name = search.trim();
                            setSearch('');
                            void onCreatePerson(name).then((personId) =>
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
                document.people.map((person) => person.name).join(', ')
              ),
            pending: state('analysis'),
            note: wasRead(
              (document.auto.people ?? []).join(', '),
              document.people.map((person) => person.name).join(', '),
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
                  options={subjects.map((subject) => ({
                    value: subject.id,
                    label: `${subject.name} · ${subject.kind}`,
                  }))}
                  // Adding one takes both halves — a name with no kind is not a thing anybody can
                  // file by — so the footer asks for the kind before it offers to add (03 §3.3.20).
                  dropdownRender={(menu) => (
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
                              void onCreateSubject(chosenKind, name).then((subjectId) =>
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
                document.subjects.map((subject) => `${subject.name} · ${subject.kind}`).join(', ')
              ),
            pending: state('analysis'),
            note: wasRead(
              (document.auto.subjects ?? [])
                .map((subject) => `${subject.name} · ${subject.kind}`)
                .join(', '),
              document.subjects.map((subject) => `${subject.name} · ${subject.kind}`).join(', '),
            ),
          },
          {
            label: t('viewer.details.documentDate'),
            value:
              draft !== null
                ? withReset(
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
                : formatDate(document.documentDate),
            pending: state('analysis'),
            note: wasRead(document.auto.date, document.documentDate ?? '', ['documentDate']),
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
                        placeOf(draft.city.trim() === '' ? null : draft.city.trim(), draft.country),
                  )
                : placeOf(document.city, document.country),
            pending: state('analysis'),
            // One fact in two boxes, so putting it back puts both back — a reset city that kept
            // somebody's country would be a place that was never read anywhere.
            note: wasRead(autoPlace, placeOf(document.city, document.country), ['city', 'country']),
          },
          {
            label: t('viewer.details.created'),
            value: new Date(document.createdAt).toLocaleString(),
          },
          {
            label: t('viewer.details.ocr'),
            value: document.ocrUsed ? t('common.yes') : t('common.no'),
            pending: state('markdown'),
          },
        ]}
      />

      {/* Save ends what Edit started, so it sits at the other end of the same list and on the same
          side: the eye leaves a form at its bottom-right corner (docs/11 §11.5). */}
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

      {/* What the document is made of, and the only place it can be rearranged (docs/11 §11.5a). */}
      <FilesSection document={document} />
    </Space>
  );
}

// A document is an ordered list of files (docs/03 §3.3.10), and this is where that list is visible
// and editable (docs/11 §11.5a). Every action here rebuilds the document — the canonical PDF, the
// preview, the text, the analysis — so the section says so once, quietly, and then stays usable
// while it happens.
function FilesSection({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  // The same queue as the grid, pointed at this document: files land here in the order chosen
  // (docs/11 §11.3, §11.5a).
  const upload = useDocumentUpload(document.id);
  const [cropping, setCropping] = useState<DocumentFileDto | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(document.id) });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const reorder = useMutation({
    mutationFn: (order: string[]) => documentApi.reorderFiles(document.id, { order }),
    onSuccess: () => {
      void message.success(t('viewer.files.rebuilding'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // Not a deletion, and it does not carry the reader off to the new document either: they are
  // looking at this one, and the file they split off is a document they can find (docs/11 §11.5a).
  const split = useMutation({
    mutationFn: (fileId: string) => documentApi.splitFile(document.id, fileId),
    onSuccess: () => {
      void message.success(t('viewer.files.splitDone'), 3);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const move = (index: number, by: number): void => {
    const order = document.files.map((file) => file.id);
    const target = index + by;
    const moved = order[index];
    const displaced = order[target];
    if (moved === undefined || displaced === undefined) return;
    order[index] = displaced;
    order[target] = moved;
    reorder.mutate(order);
  };

  const busy = reorder.isPending || split.isPending;

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t('viewer.files.title')}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('viewer.files.rebuildNote')}
          </Typography.Text>
        </Col>
        <Col>
          <UploadButton onFiles={upload.send} label={t('viewer.files.add')} />
        </Col>
      </Row>

      {/* On screen before a byte is sent, above the files it is about to join. */}
      {upload.items.map((queued) => (
        <UploadingRow
          key={queued.key}
          upload={queued}
          onDismiss={() => upload.dismiss(queued.key)}
        />
      ))}

      <List
        dataSource={document.files}
        rowKey="id"
        size="small"
        renderItem={(file: DocumentFileDto, index: number) => (
          <List.Item
            actions={[
              <Button
                key="download"
                size="small"
                type="link"
                disabled={!file.available}
                download={file.name}
                {...(file.available
                  ? { href: documentFiles.fileContent(document.id, file.id) }
                  : {})}
              >
                {t('viewer.files.download')}
              </Button>,
              ...(file.isImage
                ? [
                    <Button key="crop" size="small" type="link" onClick={() => setCropping(file)}>
                      {t('viewer.files.crop')}
                    </Button>,
                  ]
                : []),
              <Button
                key="up"
                size="small"
                type="text"
                aria-label={t('viewer.files.moveUp', { name: file.name })}
                icon={<ArrowUpOutlined />}
                disabled={index === 0 || busy}
                onClick={() => move(index, -1)}
              />,
              <Button
                key="down"
                size="small"
                type="text"
                aria-label={t('viewer.files.moveDown', { name: file.name })}
                icon={<ArrowDownOutlined />}
                disabled={index === document.files.length - 1 || busy}
                onClick={() => move(index, 1)}
              />,
              // Splitting off the only file is not offered at all, rather than refused after the
              // fact: a document is emptied by deleting it (docs/11 §11.5a).
              ...(document.files.length > 1
                ? [
                    <Button
                      key="split"
                      size="small"
                      type="link"
                      disabled={busy}
                      onClick={() => split.mutate(file.id)}
                    >
                      {t('viewer.files.splitOff')}
                    </Button>,
                  ]
                : []),
            ]}
          >
            <List.Item.Meta
              avatar={
                <div
                  style={{
                    width: 44,
                    height: 56,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--legere-well)',
                    overflow: 'hidden',
                  }}
                >
                  {file.isImage && file.available ? (
                    // An API route that 302s to a signed URL, or streams the volume's own bytes
                    // (docs/10 §10.8).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={documentFiles.fileContent(document.id, file.id)}
                      alt=""
                      loading="lazy"
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                    />
                  ) : (
                    <FileTextOutlined
                      style={{ fontSize: 20, color: token.colorTextQuaternary }}
                      aria-hidden
                    />
                  )}
                </div>
              }
              title={
                <Space size={4} wrap>
                  <span>{file.name}</span>
                  {!file.available && <Tag color="default">{t('viewer.files.missing')}</Tag>}
                  {file.crop !== null && <Tag color="blue">{t('viewer.files.cropped')}</Tag>}
                </Space>
              }
              description={
                <Space direction="vertical" size={0}>
                  {/* What it is and what it weighs. The kind is the mime type rather than the
                      extension: the name above already ends in `.jpg`. */}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {`${file.mimeType} · ${formatBytes(file.sizeBytes)}`}
                  </Typography.Text>
                  {/* Where the bytes live is a fact about the file, and it belongs beside the file
                      rather than in a section of its own (docs/11 §11.5a). */}
                  {file.refs.map((ref) => (
                    <Typography.Text
                      key={`${ref.libraryId}:${ref.path}`}
                      type="secondary"
                      style={{ fontSize: 12 }}
                      code
                    >
                      {`${ref.libraryName}: ${ref.path}`}
                    </Typography.Text>
                  ))}
                </Space>
              }
            />
          </List.Item>
        )}
      />

      {cropping !== null && (
        <CropEditor
          open
          documentId={document.id}
          file={cropping}
          onClose={() => {
            setCropping(null);
            refresh();
          }}
        />
      )}
    </Space>
  );
}

// The history of the document (docs/03 §3.3.18): who did what to it, and what the pipeline made of
// it, newest first. Fetched only when the tab is open — most visits never ask.
function LogPane({ id, active, processing }: { id: string; active: boolean; processing: boolean }) {
  const t = useTranslations();
  const events = useQuery({
    queryKey: documentKeys.events(id),
    queryFn: () => documentApi.events(id),
    enabled: active,
    // While the pipeline is working there is more to come, and not every entry follows a step
    // change — somebody else may be editing the same document (docs/10 §10.5).
    refetchInterval: processing ? LIVE_REFRESH_MS : false,
  });

  if (events.isPending) return <Spin />;
  const items = events.data?.items ?? [];
  if (items.length === 0) return <Empty description={t('viewer.log.empty')} />;

  return (
    <Table
      dataSource={items}
      rowKey="id"
      size="small"
      // The whole page at once: a log is scanned, not paged through, and the server already caps it.
      pagination={false}
      columns={[
        {
          title: t('viewer.log.when'),
          dataIndex: 'at',
          width: 180,
          render: (_: unknown, event: DocumentEventDto) => (
            <Typography.Text type="secondary">
              {new Date(event.at).toLocaleString()}
            </Typography.Text>
          ),
        },
        {
          title: t('viewer.log.what'),
          dataIndex: 'type',
          render: (_: unknown, event: DocumentEventDto) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>{describeEvent(event, t)}</Typography.Text>
              {/* The message travels with the row that failed: the log is where somebody goes when
                  something went wrong (docs/11 §11.5). */}
              {event.payload.error !== undefined && (
                <Typography.Text type="danger" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {event.payload.error}
                </Typography.Text>
              )}
              {/* Who did the work and under what id — the thread from this line into the log of the
                  container that produced it. Monospace, because these are values to be compared and
                  copied rather than read (docs/11 §11.15). The host is only ever sent to an admin. */}
              {event.payload.service !== undefined && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                  {[event.payload.service, event.payload.endpoint, event.payload.requestId]
                    .filter((part) => part !== undefined && part !== '')
                    .join(' · ')}
                </Typography.Text>
              )}
            </Space>
          ),
        },
        {
          title: t('viewer.log.who'),
          dataIndex: 'actor',
          width: 160,
          // Empty is the pipeline acting on its own, and an em dash says that out loud.
          render: (actor: string | null) =>
            actor === null ? <Typography.Text type="secondary">—</Typography.Text> : actor,
        },
      ]}
    />
  );
}

// One sentence per entry, built from the payload each type happens to carry. Written here rather
// than on the server: it is the reader's language, and the server does not know it (docs/10 §10.3).
function describeEvent(event: DocumentEventDto, t: ReturnType<typeof useTranslations>): string {
  const { payload } = event;
  const step = payload.step === undefined ? '' : t(`viewer.steps.${payload.step}`);

  if (event.type === 'STEP_STARTED') return t('viewer.log.stepStarted', { step });
  if (event.type === 'STEP_FINISHED') {
    const status = payload.status ?? '';
    const reason =
      payload.reason === undefined ? '' : ` — ${t(`viewer.skipReasons.${payload.reason}`)}`;
    return `${t('viewer.log.stepFinished', { step, status })}${reason}`;
  }
  if (event.type === 'QUEUED') {
    const steps = (payload.steps ?? []).map((one) => t(`viewer.steps.${one}`)).join(', ');
    return steps === '' ? t('viewer.log.queued') : t('viewer.log.queuedSteps', { steps });
  }
  // 🔒 The path of a library file only reaches an admin (docs/03 §3.3.18), so each of these
  // sentences has a form that names no folder: the entry still says what happened.
  const path = payload.path;
  if (event.type === 'CREATED') {
    return path === undefined ? t('viewer.log.createdBare') : t('viewer.log.created', { path });
  }
  if (event.type === 'FILE_ATTACHED') {
    return path === undefined
      ? t('viewer.log.fileAttachedBare')
      : t('viewer.log.fileAttached', { path });
  }
  if (event.type === 'FILE_MISSING') {
    return path === undefined
      ? t('viewer.log.fileMissingBare')
      : t('viewer.log.fileMissing', { path });
  }

  const changes = Object.entries(payload.changes ?? {})
    .map(([field, change]) =>
      t('viewer.log.change', {
        field: t(`viewer.details.${field}`),
        from:
          change.from === null || change.from === undefined || change.from === ''
            ? '—'
            : change.from,
        to: change.to === null || change.to === undefined || change.to === '' ? '—' : change.to,
      }),
    )
    .join('; ');
  return changes === '' ? t('viewer.log.metaChanged') : changes;
}

// The same choice made twice: two sets of links are equal when they hold the same ids, whatever
// order the control put them in — reordering a multi-select is not an edit.
function sameIds(chosen: string[], current: string[]): boolean {
  if (chosen.length !== current.length) return false;
  const held = new Set(current);
  return chosen.every((id) => held.has(id));
}

// Something typed that is not already in the catalogue — the only case where offering to add a
// person is useful rather than noise.
function isNewName(search: string, people: Array<{ name: string }>): boolean {
  const name = search.trim().toLowerCase();
  return name !== '' && !people.some((person) => person.name.toLowerCase() === name);
}

// A calendar day in the reader's own format. Rendered from the parts rather than by parsing into a
// Date: "2019-03-01" is a day, and a Date would make it a moment somewhere.
function formatDate(date: string | null): string {
  if (date === null) return '';
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) return date;
  return new Intl.DateTimeFormat(navigator.language).format(
    new Date(Number(year), Number(month) - 1, Number(day)),
  );
}

function placeOf(city: string | null, country: string | null): string {
  return [city, displayCountry(country)].filter((part) => part !== null && part !== '').join(', ');
}

// Every language Intl can name, plus the tags already on the document that are not among them —
// `sr-Latn` is a real answer and no two-letter sweep will find it. Offered rather than left to be
// typed because a person adding Russian knows the word and not the code (docs/11 §11.5); the field
// still takes free tags for what neither list has.
function languageOptions(
  current: string[],
  auto: string[],
): Array<{ value: string; label: string }> {
  const listed = new Set(LANGUAGE_OPTIONS.map((option) => option.value));
  const carried = [...new Set([...current, ...auto])]
    .filter((tag) => !listed.has(tag))
    .map((tag) => ({ value: tag, label: `${displayLanguage(tag)} (${tag})` }));
  return [...carried, ...LANGUAGE_OPTIONS];
}

function statusColor(status: StepStatus): string {
  if (status === 'RUNNING') return 'processing';
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'PENDING') return 'blue';
  return 'default';
}

// Every two-letter code Intl can put a name to, sorted by that name. Built by asking about all 676
// combinations and keeping the ones it answers: a list of countries or of languages is data that
// goes out of date, and one asked of Intl cannot.
function namedCodes(
  alphabet: string,
  describe: (code: string) => string,
  label: (code: string, name: string) => string,
): Array<{ value: string; label: string }> {
  const letters = alphabet.split('');
  const options: Array<{ value: string; label: string }> = [];
  for (const first of letters) {
    for (const second of letters) {
      const code = `${first}${second}`;
      const name = describe(code);
      // Intl answers an unknown code with the code itself, which is how a non-country is told from a
      // country without keeping a list of either.
      if (name !== code) options.push({ value: code, label: label(code, name) });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

// ISO 3166-1 alpha-2, named: "Montenegro", not "ME".
const COUNTRY_OPTIONS: Array<{ value: string; label: string }> = namedCodes(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  (code) => displayCountry(code) ?? code,
  (_code, name) => name,
);

// ISO 639-1, named and with the tag in tow: "Russian (ru)". The tag is shown because it is what
// travels and what the pipeline reads, and a person correcting a language should be able to see the
// two agree.
const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = namedCodes(
  'abcdefghijklmnopqrstuvwxyz',
  displayLanguage,
  (code, name) => `${name} (${code})`,
);

// "ME" → "Montenegro", in the reader's own language. Intl knows the list; we do not keep one.
function displayCountry(code: string | null): string | null {
  if (code === null) return null;
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// "ru" → "Russian" in the reader's own language, "sr-Latn" → "Serbian (Latin)". Intl does the work;
// no table of language names to keep up to date.
function displayLanguage(tag: string): string {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
