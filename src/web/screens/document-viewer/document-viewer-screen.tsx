'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DisconnectOutlined,
  DownOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  DatePicker,
  Divider,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tabs,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DefinitionList } from '../../shared/ui/definition-list';
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  DOCUMENT_STEPS,
  type DocumentDetailDto,
  type DocumentEventDto,
  type DocumentFileDto,
  type DocumentFileVersionDto,
  type DocumentListDto,
  type DocumentResetEntry,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import {
  fieldSchemaFor,
  moneyValueSchema,
  type DocumentFieldSchema,
  type DocumentFieldSpec,
} from '../../../shared/contracts/document-fields';
import {
  pageFormatSchema,
  type PageFormat,
  type StepStatus,
} from '../../../shared/contracts/enums';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { documentApi, documentFiles, documentKeys } from '../../entities/document';
import { personApi, personKeys } from '../../entities/person';
import { searchApi, searchKeys } from '../../entities/search';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { CropEditor } from '../../features/crop-editor';
import { UploadButton } from '../../features/document-upload';
import { useUploadQueue } from '../../features/upload-queue';
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
    // The catalogues belong on this list for the same reason and were missing from it: the analysis
    // writes people and subjects (05 §5.5), so a list fetched when the screen mounted has never
    // heard of the names the step just created — and the editor would offer no label for them.
    void queryClient.invalidateQueries({ queryKey: personKeys.all });
    void queryClient.invalidateQueries({ queryKey: subjectKeys.all });
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

  // Reading the document again, from the pages up: the recogniser of last resort runs in step 3,
  // and everything downstream of it is read off what that step wrote (docs/05 §5.5).
  const readAgain = useMutation({
    mutationFn: () => documentApi.reprocess(id, { steps: ['markdown', 'analysis'] }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  if (document.isPending) return <Spin />;
  if (document.data === undefined) return <Empty description={t('errors.codes.NOT_FOUND')} />;

  const detail = document.data;

  return (
    // The two panes, and the height the window has: the classes are where the flex chain down to
    // the document is hung, since a percentage height stops at the first ancestor without one
    // (docs/11 §11.5).
    <Row gutter={[16, 16]} className="legere-viewer">
      {/* 🔒 Nothing whatever stands above the tabs: they are the one strip of chrome this column
          spends, and the open tab takes the rest of the height the viewport has. A name read once on
          arrival must not be charged to every page of every document, and the thing it names is on
          the screen being looked at — so the name is beside the document rather than over it
          (docs/11 §11.5).
          🔒 And nothing around them either: no card, no border, no padding of its own. A frame drawn
          round the whole zone is a frame drawn round the one thing the screen exists to show — the
          document's own page is the surface here, and the panel beside it keeps its cards. */}
      <Col xs={24} lg={16} className="legere-viewer-main">
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
                  isAdmin={isAdmin}
                  onReadAgain={() => readAgain.mutate()}
                  readingAgain={readAgain.isPending}
                />
              ),
            },
            {
              key: 'related',
              label: t('viewer.tabs.related'),
              children: <RelatedPane id={id} active={active === 'related'} />,
            },
            {
              key: 'log',
              label: t('viewer.tabs.log'),
              children: <LogPane document={detail} active={active === 'log'} isAdmin={isAdmin} />,
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
                    const kindId = known?.id ?? (await subjectKindApi.create({ name: wanted })).id;
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
            {
              key: 'files',
              label: t('viewer.tabs.files'),
              children: <FilesPane document={detail} isAdmin={isAdmin} />,
            },
          ]}
        />
      </Col>

      {/* The panel of things about the document scrolls in itself as well, so what is on the left
          stays where it is while what is on the right is read (docs/11 §11.5). */}
      <Col xs={24} lg={8} className="legere-viewer-side">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* The panel of things *about* the document opens with what it is called, which is where
              the rest of what is known about it already lives (docs/11 §11.5). 🔒 There is exactly
              one title and one description on the screen: a name rendered twice is a name somebody
              edits in the wrong place. */}
          <Card>
            {/* Wrapping rather than truncating, and breaking a long word rather than escaping the
                column: a document's name is the one string here nobody may be shown half of. */}
            <Typography.Title
              level={4}
              style={{ marginTop: 0, marginBottom: 8, wordBreak: 'break-word' }}
              editable={{
                onChange: (title) => {
                  if (title.trim() !== '' && title !== detail.title) update.mutate({ title });
                },
                triggerType: ['icon', 'text'],
                // Names the pencil as well as its tooltip: two pencils on one panel both called
                // "Edit" are two controls nobody listening to the page can tell apart.
                tooltip: t('viewer.editTitle'),
              }}
            >
              {detail.title}
            </Typography.Title>

            {/* What this document is, for somebody who has never seen it — directly under the name,
                in secondary text, edited in place on the same terms (docs/11 §11.5). An em dash
                where the analysis has written none: a blank reads as a rendering bug, and the dash
                is also what there is to click on to write one. */}
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0 }}
              editable={{
                // The value, never the em dash standing in for it: an editor seeded with "—" would
                // make the placeholder the description the moment somebody pressed Enter.
                text: detail.description ?? '',
                onChange: (description) => {
                  const next = description.trim() === '' ? null : description.trim();
                  if (next !== detail.description) update.mutate({ description: next });
                },
                triggerType: ['icon', 'text'],
                autoSize: { minRows: 2, maxRows: 8 },
                tooltip: t('viewer.editDescription'),
              }}
            >
              {detail.description ?? '—'}
            </Typography.Paragraph>

            {/* What the analysis would have called it, when somebody has since called it something
                else — in the same place every other correction keeps its provenance, and a click
                away from being the name again (docs/11 §11.5). */}
            {detail.auto.title !== undefined && detail.auto.title !== detail.title && (
              <div className="legere-definition-note" style={{ marginTop: 8 }}>
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
          </Card>

          {/* 🔒 What is left of the panel, and why (docs/11 §11.5): it says what the document is
              called, what it is about in a line, and what it looks like. Everything that *acts* on
              the document has gone to the tab that owns the question it answers — Download and
              Delete to Files, the links to Related, the pipeline to Log — because a panel carrying
              all of them was a second screen standing beside the first, drawn in full on every
              document whether or not anybody had come to act on one. */}
          <Card>
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
          </Card>

          {/* The page itself, last in the panel (docs/11 §11.5). Small on purpose: the readable copy
              is the pane on the left, and this is the answer to "is this the right document" —
              which is a glance, not a read. */}
          {detail.hasPreview && (
            <Card styles={{ body: { padding: 8 } }}>
              {/* The URL is an API route that 302s to a signed URL; next/image would proxy and cache
                  private content through a shared optimizer (docs/10 §10.8). */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={documentFiles.preview(detail.id)}
                alt=""
                loading="lazy"
                style={{
                  display: 'block',
                  width: '100%',
                  maxHeight: 320,
                  objectFit: 'contain',
                  // A page has an edge; a floating bitmap does not (docs/11 §11.15).
                  background: 'var(--legere-well)',
                }}
              />
            </Card>
          )}
        </Space>
      </Col>
    </Row>
  );
}

// What is being done to the document right now, at the head of the tab that also says what has been
// done to it (docs/11 §11.5): "is it finished, and did anything break" and "what happened" are one
// question asked twice, and the first used to stand in the sidebar of every document while the
// second was a tab away.
function ProcessingSection({
  document,
  isAdmin,
}: {
  document: DocumentDetailDto;
  isAdmin: boolean;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [steps, setSteps] = useState<DocumentStep[]>([]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(document.id) });
  };

  // Asking for this one document to be analysed however long it is. Separate from the reprocess
  // button beside it, because it is a different request: not "run this again" but "the limit does
  // not apply to this one" (docs/05 §5.5 step 4).
  const analyseInFull = useMutation({
    mutationFn: () =>
      documentApi.reprocess(document.id, { steps: ['analysis'], analyseInFull: true }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const reprocess = useMutation({
    mutationFn: () => documentApi.reprocess(document.id, steps.length === 0 ? {} : { steps }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      setSteps([]);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* A heading rather than a card: the main column draws the document on the page itself, and
          a box inside a tab would be a frame around one half of it (docs/11 §11.5). */}
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t('viewer.processing.title')}
      </Typography.Title>

      {/* One row per step: pick it, see its state, read what happened to it. A grid rather than
          stacked rows because the status tags have different widths — laid out independently, every
          label would start at a different place (docs/11 §11.5). */}
      <div className={`legere-steps${isAdmin ? ' has-select' : ''}`}>
        {DOCUMENT_STEPS.map((step) => {
          const reason = document.skipReasons[step];
          const label = t(`viewer.steps.${step}`);
          const failure = document.failedStep === step ? document.processingError : null;
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
              <Tag color={statusColor(document.steps[step])}>{document.steps[step]}</Tag>
              <Typography.Text>{label}</Typography.Text>
              {/* SKIPPED alone reads like a failure; the reason says which harmless one it was, and
                  whether it is something an admin can change (docs/03 §3.3.10). */}
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
      {document.processingError !== null && document.failedStep === null && (
        <Typography.Text type="danger" style={{ whiteSpace: 'pre-wrap' }}>
          {document.processingError}
        </Typography.Text>
      )}

      {isAdmin && (
        <Space wrap>
          <Button onClick={() => reprocess.mutate()} loading={reprocess.isPending}>
            {steps.length === 0
              ? t('viewer.processing.reprocessAll')
              : t('viewer.processing.reprocessSelected', { count: steps.length })}
          </Button>

          {/* The way past the automatic limit, offered exactly where the limit is visible: the
              analysis row says it was skipped for being long, and this is the answer to that
              (docs/11 §11.5). */}
          {document.skipReasons.analysis === 'TOO_MANY_PAGES' && (
            <Button
              onClick={() => analyseInFull.mutate()}
              loading={analyseInFull.isPending}
              type="primary"
            >
              {t('viewer.processing.analyseInFull')}
            </Button>
          )}
        </Space>
      )}
    </Space>
  );
}

// 🔒 The one control in Legere that destroys anything (docs/03 §3.3.10, docs/11 §11.5d). At the foot
// of the Files tab, under the rows it is about to count: a deletion is a decision about the bytes,
// and the whole list stands between it and Download at the top — a destructive action sharing an
// edge with Download is one somebody presses by accident.
//
// The confirmation is a modal rather than a popover because it has an inventory to read out: what
// goes, and — the part nobody can infer — what stays and what will happen to it.
function DeleteSection({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [asking, setAsking] = useState(false);

  // The originals that outlive the document, because they are on a volume Legere may not write to
  // (docs/03 §3.3.9). A document made only of uploads has none, and is not told about a kept file
  // that does not exist.
  const onVolume = document.files.filter((file) => file.refs.length > 0).length;

  const remove = useMutation({
    mutationFn: () => documentApi.remove(document.id),
    onSuccess: () => {
      setAsking(false);
      void message.success(t('viewer.delete.done'), 3);
      // The archive is re-fetched, and the reader is taken off an address that no longer resolves.
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      router.push('/documents');
    },
    // The modal stays open on a failure, with the error where it happened.
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    // A rule of its own above it, and nothing after it: this is where the tab ends (docs/11 §11.5d).
    <>
      <Divider style={{ marginBottom: 16 }} />
      <Button danger onClick={() => setAsking(true)}>
        {t('viewer.delete.action')}
      </Button>

      <Modal
        open={asking}
        title={t('viewer.delete.title', { title: document.title })}
        okText={t('viewer.delete.action')}
        okType="danger"
        okButtonProps={{ type: 'primary', danger: true }}
        cancelText={t('common.actions.cancel')}
        confirmLoading={remove.isPending}
        onCancel={() => setAsking(false)}
        onOk={() => remove.mutate()}
      >
        <Space direction="vertical" size="small">
          <Typography.Text>
            {t('viewer.delete.goes', {
              files: document.files.length,
              size: formatBytes(document.sizeBytes),
            })}
          </Typography.Text>
          {onVolume > 0 && (
            <Typography.Text type="secondary">
              {t('viewer.delete.kept', { files: onVolume })}
            </Typography.Text>
          )}
          <Typography.Text type="warning">{t('viewer.delete.forGood')}</Typography.Text>
        </Space>
      </Modal>
    </>
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
        // The height is the pane's, not a slice of the window guessed at in advance: where the two
        // panes stand side by side the document reaches the foot of the screen, and where the layout
        // is one column it falls back to a fixed share of it (docs/11 §11.5).
        className="legere-viewer-preview"
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
// What a reader dismissed, for this session (docs/05 §5.6b): the server proposes and never
// remembers being refused, so the refusal lives here — and only until the tab closes.
const dismissedLinksKey = (id: string): string => `legere:dismissed-link-suggestions:${id}`;

function readDismissed(id: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(dismissedLinksKey(id));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(id: string, ids: readonly string[]): void {
  try {
    window.sessionStorage.setItem(dismissedLinksKey(id), JSON.stringify(ids));
  } catch {
    // A full store is not a reason dismissing should break.
  }
}

// The edges of this document (docs/03 §3.3.23, docs/11 §11.5e): a picker for linking by hand, the
// linked documents, and beneath them — quieter — the candidates the archive found by the identifiers
// they share (docs/05 §5.6b), each saying which ones matched.
//
// A tab rather than a card in the sidebar: a link is a document, and a document deserves the width
// one is shown at — in an 8/24 column each was a truncated line of text, and the picker had one
// search box's worth of room to answer in. 🔒 The tab is drawn whether or not there is anything in
// it: the card's "draw nothing at all" was right for a card standing in a panel nobody asked to see,
// but a tab that vanished with the last link would take the picker with it, and the first link could
// then only be made on a document that already has one.
function RelatedPane({ id, active }: { id: string; active: boolean }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [dismissed, setDismissed] = useState<readonly string[]>(() => readDismissed(id));
  const [query, setQuery] = useState('');

  // Fetched only when the tab is open, exactly like the log: the suggestions cost the server one
  // search per identifier this document carries (docs/05 §5.6b), and most visits never ask.
  const links = useQuery({
    queryKey: documentKeys.links(id),
    queryFn: () => documentApi.links(id),
    enabled: active,
  });
  const suggestions = useQuery({
    queryKey: documentKeys.linkSuggestions(id),
    queryFn: () => documentApi.linkSuggestions(id),
    enabled: active,
  });
  // The same search the overlay runs (docs/11 §11.5e): papers related only in somebody's head are
  // found the way anything is found.
  const found = useQuery({
    queryKey: searchKeys.query({ q: query, mode: 'hybrid' }),
    queryFn: () => searchApi.search({ q: query, mode: 'hybrid' }),
    enabled: query.trim().length > 0,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.links(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.linkSuggestions(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(id) });
  };

  const link = useMutation({
    mutationFn: (documentId: string) => documentApi.createLink(id, documentId),
    onSuccess: () => {
      setQuery('');
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });
  const unlink = useMutation({
    mutationFn: (documentId: string) => documentApi.deleteLink(id, documentId),
    onSuccess: refresh,
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const linked = links.data?.items ?? [];
  const linkedIds = new Set(linked.map((item) => item.document.id));
  const proposals = (suggestions.data?.items ?? []).filter(
    (candidate) =>
      !linkedIds.has(candidate.document.id) && !dismissed.includes(candidate.document.id),
  );

  const options = (found.data?.items ?? [])
    .filter((hit) => hit.document.id !== id && !linkedIds.has(hit.document.id))
    .map((hit) => ({ value: hit.document.id, label: hit.document.title }));

  const dismiss = (documentId: string): void => {
    setDismissed((current) => {
      const next = [...current, documentId];
      writeDismissed(id, next);
      return next;
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* Above the list rather than under it, for the reason Add files stands above the file rows:
          the thing somebody came to do is not at the bottom of what is already done. */}
      <Select
        showSearch
        // The server ranks; re-filtering by label here would second-guess it.
        filterOption={false}
        style={{ width: '100%', maxWidth: 480 }}
        placeholder={t('viewer.links.link')}
        aria-label={t('viewer.links.link')}
        value={null}
        onSearch={setQuery}
        loading={found.isFetching}
        onChange={(documentId: string) => link.mutate(documentId)}
        options={options}
        notFoundContent={null}
      />

      {linked.length === 0 ? (
        <Empty description={t('viewer.links.none')} />
      ) : (
        <List
          dataSource={linked}
          rowKey={(item) => item.document.id}
          size="small"
          renderItem={(item) => (
            <List.Item
              actions={[
                <Tooltip key="unlink" title={t('viewer.links.unlink')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<DisconnectOutlined />}
                    aria-label={t('viewer.links.unlink')}
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate(item.document.id)}
                  />
                </Tooltip>,
              ]}
            >
              <List.Item.Meta
                avatar={<DocumentThumb document={item.document} />}
                title={<Link href={`/documents/${item.document.id}`}>{item.document.title}</Link>}
                description={
                  item.document.documentType === null ? null : (
                    <Tag>{item.document.documentType.name}</Tag>
                  )
                }
              />
            </List.Item>
          )}
        />
      )}

      {proposals.length > 0 && (
        <>
          {/* Quieter than the links, and under a heading of their own: a proposal is not a fact
              about the document until somebody says so (docs/05 §5.6b). */}
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t('viewer.links.suggestions')}
          </Typography.Title>
          <List
            dataSource={proposals}
            rowKey={(candidate) => candidate.document.id}
            size="small"
            renderItem={(candidate) => (
              <List.Item
                actions={[
                  <Button
                    key="accept"
                    size="small"
                    type="link"
                    disabled={link.isPending}
                    onClick={() => link.mutate(candidate.document.id)}
                  >
                    {t('viewer.links.accept')}
                  </Button>,
                  <Button
                    key="dismiss"
                    size="small"
                    type="text"
                    onClick={() => dismiss(candidate.document.id)}
                  >
                    {t('viewer.links.dismiss')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<DocumentThumb document={candidate.document} />}
                  title={
                    <Typography.Text type="secondary">{candidate.document.title}</Typography.Text>
                  }
                  // Why this is here (docs/05 §5.6b): the identifiers the two documents share.
                  description={t('viewer.links.cites', {
                    tokens: candidate.matchedTokens.join(', '),
                  })}
                />
              </List.Item>
            )}
          />
        </>
      )}
    </Space>
  );
}

// The other document's first page, at the size of a row (docs/11 §11.5e) — what the sidebar card
// never had the width for, and the fastest answer to "which act was that". The same fallback the
// file rows use: an artifact can be missing even where the step says it was made.
function DocumentThumb({ document }: { document: DocumentListDto }) {
  const { token } = theme.useToken();

  return (
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
      {document.hasPreview ? (
        // An API route that 302s to a signed URL (docs/10 §10.8).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={documentFiles.thumb(document.id)}
          alt=""
          loading="lazy"
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      ) : (
        <FileTextOutlined style={{ fontSize: 20, color: token.colorTextQuaternary }} aria-hidden />
      )}
    </div>
  );
}

function DownloadSplitButton({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const ready = document.steps.canonical === 'DONE';

  return (
    <Space.Compact>
      <Tooltip title={ready ? undefined : t('viewer.canonical.assembling')}>
        {/* antd drops the href of a disabled button, so there is nothing left to click through to
            while the document is not one piece yet (docs/11 §11.5b). */}
        <Button
          type="primary"
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
  onReadAgain,
  readingAgain,
  isAdmin,
}: {
  document: DocumentDetailDto;
  markdown: string | null;
  loading: boolean;
  onReadAgain: () => void;
  readingAgain: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations();
  // The verdict the analysis returned about this very text (docs/03 §3.3.10). It was written down
  // and read by nobody, which made it a fact the archive knew and never said.
  const quality = document.auto.textQuality;

  if (loading) return <Spin />;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 🔒 Above the text and above the *absence* of it. A document whose recognition returned
          nothing is the case this warning exists for, and it is exactly the case with no text to
          stand under: drawn after the empty state, it would never appear on the one document that
          needs it most (docs/11 §11.5). */}
      {(quality === 'PARTIAL' || quality === 'NONE') && (
        <Alert
          type="warning"
          showIcon
          message={t(`viewer.textQuality.${quality}`)}
          description={t('viewer.textQuality.explained')}
          {...(isAdmin
            ? {
                action: (
                  <Button size="small" onClick={onReadAgain} loading={readingAgain}>
                    {t('viewer.textQuality.readAgain')}
                  </Button>
                ),
              }
            : {})}
        />
      )}
      {markdown === null || markdown === '' ? (
        <Empty
          description={
            document.steps.markdown === 'FAILED'
              ? t('viewer.textFailed')
              : document.steps.markdown === 'RUNNING' ||
                  document.steps.markdown === 'PENDING' ||
                  document.steps.markdown === 'QUEUED'
                ? t('viewer.textPending')
                : t('viewer.noText')
          }
        />
      ) : (
        <RenderedMarkdown markdown={markdown} />
      )}
    </Space>
  );
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
  pageFormat?: PageFormat;
  // The typed fields of the document's schema (docs/03 §3.3.10a): each key set becomes MANUAL,
  // null clears value and source both.
  fields?: Record<string, unknown>;
  reset?: DocumentResetEntry[];
};

// The shapes a person may file a document under (docs/05 §5.5 step 1), in the order they are
// offered: what the pipeline decided, then the two ways of overruling it.
const PAGE_FORMATS = pageFormatSchema.options;

// What a scalar typed field holds while it is being edited (docs/03 §3.3.10a): each kind keeps the
// shape its input works in, and only Save turns it back into the stored value. A `table` has no
// draft because the form does not edit one (docs/11 §11.5).
type FieldDraft =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number | null }
  | { kind: 'date'; value: string | null }
  | { kind: 'money'; amount: number | null; currency: string };

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
  pageFormat: PageFormat;
  fields: Record<string, FieldDraft>;
};

// A catalogue row is a living one by construction: `/api/people` and `/api/subjects` return only
// what has not been deleted (docs/07 §7.3).
function living<T>(row: T): T & { deleted: boolean } {
  return { ...row, deleted: false };
}

function isDeleted(
  options: ReadonlyArray<{ id: string; deleted: boolean }>,
  value: unknown,
): boolean {
  return options.some((option) => option.id === value && option.deleted);
}

// The catalogue first, then anything the document carries that the catalogue does not: a row is
// identified by its id, and the catalogue's copy wins when both have one, since it is the one a
// person can still choose.
function mergeById<T extends { id: string }>(
  catalogue: readonly T[],
  onDocument: readonly T[],
): T[] {
  const seen = new Set(catalogue.map((entry) => entry.id));
  return [...catalogue, ...onDocument.filter((entry) => !seen.has(entry.id))];
}

// Which step writes which field (docs/05 §5.5): the page count comes with the preview, the text and
// the languages with the parse, the place and the documentType with the AI step. A field whose step
// has not settled is a field whose value is provisional, and it says so rather than showing an em
// dash that reads as "there is none".
//
// Module-level because two of the pane's three sections ask it (docs/11 §11.5), and the second of
// them is drawn apart from the form so that opening the form leaves it alone.
function pendingState(
  document: DocumentDetailDto,
  steps: readonly DocumentStep[],
): 'PENDING' | 'RUNNING' | undefined {
  const statuses = steps.map((step) => document.steps[step]);
  if (statuses.includes('RUNNING')) return 'RUNNING';
  // A field is provisional whether a worker is on the way or nothing is scheduled at all; which of
  // those it is belongs to the step's own chip, not to every field the step writes.
  return statuses.includes('PENDING') || statuses.includes('QUEUED') ? 'PENDING' : undefined;
}

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
  subjects: Array<{ id: string; kindId: string; kind: string; name: string }>;
  subjectKinds: Array<{ id: string; name: string }>;
  onCreateSubject: (kind: string, name: string) => Promise<string>;
  onSave: (input: MetaChange) => void;
  saving: boolean;
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

    if (Object.keys(change).length > 0) onSave(change);
    stopEditing();
  };

  // E for edit, Escape to back out. 🔒 Ignored while anything typed into is holding the focus, or
  // typing an "e" into the city would turn into a command (docs/11 §11.5). The listener is on the
  // window, so this covers the title and the description being edited in place in the sidebar as
  // well as this pane's own inputs: a bare letter that opens a form while somebody is writing a
  // title is a bare letter that eats the title.
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
  // The wrapper stands whether or not the button does: a tree that changed shape around the input
  // on the first diverging keystroke would remount it and eat the keys that follow.
  const withReset = (
    fields: DocumentResetEntry[],
    control: ReactNode,
    differs: boolean,
  ): ReactNode => (
    <Space size={4} wrap>
      {control}
      {differs && !fields.some((field) => reset.includes(field)) && (
        <Button size="small" type="link" onClick={() => resetFields(fields)}>
          {t('viewer.details.reset')}
        </Button>
      )}
    </Space>
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
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* 🔒 The Edit button stands in this section's own heading and not above the pane: a control
            belongs over the rows it acts on and over no others, and the two sections below hold
            nothing it could touch (docs/11 §11.5). */}
        <div className="legere-section-head">
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t('viewer.details.says')}
          </Typography.Title>
          {!editing && (
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

// A document is an ordered list of files (docs/03 §3.3.10), and this is where that list is visible
// and editable (docs/11 §11.5a). A tab of its own rather than the last section of Details: what a
// document is made of is a different question from what it is about, and it is the one thing here
// that is worked on rather than read — under the metadata it sat below a form nobody had opened and
// a table of step costs nobody had asked for. Every action rebuilds the document — the canonical
// PDF, the preview, the text, the analysis — so the pane says so once, quietly, and then stays
// usable while it happens.
//
// It is also where the document as a whole is handed over and where it is destroyed (docs/11 §11.5b,
// §11.5d): "the document as one piece", "one of the originals" and "these are the originals" are
// three answers to one question, and the dropdown of the first is a list of exactly the rows below
// it. Download stands at the top, Delete at the foot with the whole list between them.
function FilesPane({ document, isAdmin }: { document: DocumentDetailDto; isAdmin: boolean }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  // The application's one queue, pointed at this document: files land here in the order chosen, and
  // they are watched in the upload panel like every other upload (docs/11 §11.3a, §11.5a).
  const { send } = useUploadQueue();
  const [cropping, setCropping] = useState<DocumentFileDto | null>(null);
  // Which row is having its bytes replaced. The upload happens in place of a file rather than at the
  // end of the list, so the row it lands on is the only honest place to show it going (docs/11
  // §11.5a) — a queued card above the list would be about a file that is not arriving.
  const [replacing, setReplacing] = useState<string | null>(null);

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

  // A page re-photographed is still that page: the new scan takes the old one's position and the
  // page order does not move (docs/05 §5.6). The scan it displaces goes to the trash under this same
  // row, which is what makes replacing something a person can take back (docs/05 §5.7a).
  const replace = useMutation({
    mutationFn: ({ fileId, file }: { fileId: string; file: File }) =>
      documentApi.replaceFile(document.id, fileId, file),
    onMutate: ({ fileId }) => {
      setReplacing(fileId);
    },
    onSuccess: () => {
      void message.success(t('viewer.files.replaced'), 3);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
    onSettled: () => setReplacing(null),
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

  const busy = reorder.isPending || split.isPending || replace.isPending;

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {/* The two things that can be done with the document as a whole, and then — under both — the
          price of touching anything below (docs/11 §11.5a). No heading of its own: the tab is
          called Files, and a title under its own label is the same word twice. */}
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <DownloadSplitButton document={document} />
        </Col>
        <Col>
          <UploadButton
            onFiles={(file) => send([file], { documentId: document.id })}
            label={t('viewer.files.add')}
          />
        </Col>
      </Row>

      <Typography.Text type="secondary">{t('viewer.files.rebuildNote')}</Typography.Text>

      {/* Real files only: a row appears when its file has landed and the list is refetched, never
          before — what is on its way is watched in the panel (docs/11 §11.5a). */}
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
              // The picker opens on the row the new scan is for, and one file at a time: a page is
              // replaced by a page (docs/11 §11.5a). The request is ours for the reason the upload
              // button gives — the endpoint takes the file as the body itself.
              <Upload
                key="replace"
                showUploadList={false}
                disabled={busy}
                beforeUpload={(chosen) => {
                  replace.mutate({ fileId: file.id, file: chosen });
                  return Upload.LIST_IGNORE;
                }}
              >
                <Button size="small" type="link" disabled={busy} loading={replacing === file.id}>
                  {t('viewer.files.replace')}
                </Button>
              </Upload>,
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
                  {/* The same answer for a file that lies on no volume: the object storage, named as
                      such, and the key the bytes are under (docs/09 §9.2). A managed file used to say
                      nothing at all here, which made an uploaded document look like one with no
                      whereabouts.
                      🔒 Text, never a link: the key is a location and grants nothing on its own —
                      the bucket is private and only a signed URL reads it. */}
                  {file.storageKey !== null && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                      {`${t('viewer.files.objectStorage')}: ${file.storageKey}`}
                    </Typography.Text>
                  )}
                  {file.earlierVersions.length > 0 && (
                    <EarlierVersions documentId={document.id} versions={file.earlierVersions} />
                  )}
                </Space>
              }
            />
          </List.Item>
        )}
      />

      {/* Last in the tab, below everything the document can still be used for (docs/11 §11.5d). */}
      {isAdmin && <DeleteSection document={document} />}

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

// The copies a page has had, under the page that replaced them (docs/11 §11.5a). Collapsed, because
// what belongs to the document is the row above and these are the answer to a question asked rarely
// — "what did this page look like before" — which is the whole reason the old scan was kept rather
// than destroyed (docs/05 §5.6). They are in the trash, so each says where it is going: a file of
// ours names the day the sweep takes it, and a library original says it is on the volume, which no
// sweep will ever touch (docs/05 §5.7a). Getting one back into a document is the trash screen's
// business and makes a new document, so nothing here pretends to be an undo of the page order.
function EarlierVersions({
  documentId,
  versions,
}: {
  documentId: string;
  versions: DocumentFileVersionDto[];
}) {
  const t = useTranslations();

  return (
    <Collapse
      ghost
      size="small"
      items={[
        {
          key: 'versions',
          label: t('viewer.files.versions', { count: versions.length }),
          children: (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {versions.map((version) => (
                <Space key={version.id} direction="vertical" size={0}>
                  <Space size={4} wrap>
                    <span>{version.name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {`${formatBytes(version.sizeBytes)} · ${t('viewer.files.versionReplaced', {
                        date: new Date(version.trashedAt).toLocaleString(),
                      })}`}
                    </Typography.Text>
                    {/* The old scan is still readable, which is what it was kept for — down the
                        same route as the file above it, by its own id (docs/07 §7.3). */}
                    <Button
                      size="small"
                      type="link"
                      disabled={!version.available}
                      download={version.name}
                      {...(version.available
                        ? { href: documentFiles.fileContent(documentId, version.id) }
                        : {})}
                    >
                      {t('viewer.files.download')}
                    </Button>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {version.purgeAfter === null
                      ? t('viewer.files.versionOnVolume')
                      : t('viewer.files.versionGoes', {
                          date: new Date(version.purgeAfter).toLocaleString(),
                        })}
                  </Typography.Text>
                </Space>
              ))}
            </Space>
          ),
        },
      ]}
    />
  );
}

// What is being done to the document and what has been done to it, in that order (docs/11 §11.5):
// the pipeline's own panel above, the history below. They are one question asked twice — "is it
// finished, and did anything break", then "what happened" — and the first used to stand in the
// sidebar of every document while the second was a tab away.
function LogPane({
  document,
  active,
  isAdmin,
}: {
  document: DocumentDetailDto;
  active: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations();

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <ProcessingSection document={document} isAdmin={isAdmin} />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('viewer.log.history')}
        </Typography.Title>
        <HistoryTable id={document.id} active={active} processing={document.processing} />
      </Space>
    </Space>
  );
}

// The history of the document (docs/03 §3.3.18): who did what to it, and what the pipeline made of
// it, newest first. Fetched only when the tab is open — most visits never ask.
function HistoryTable({
  id,
  active,
  processing,
}: {
  id: string;
  active: boolean;
  processing: boolean;
}) {
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
              {/* What the step cost and what came out of it, beside the step it belongs to: "it
                  took four minutes" and "it returned nothing" are the two halves of one question
                  (docs/03 §3.3.18). */}
              {stepCost(event, t).length > 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {stepCost(event, t).join(' · ')}
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
  // A record, not a live reference: the title still says which paper it was after the other side
  // is gone (docs/03 §3.3.23).
  if (event.type === 'LINKED' || event.type === 'UNLINKED') {
    const title = payload.otherTitle ?? payload.otherDocumentId ?? '';
    return event.type === 'LINKED'
      ? t('viewer.log.linked', { title })
      : t('viewer.log.unlinked', { title });
  }

  const changes = Object.entries(payload.changes ?? {})
    .map(([field, change]) =>
      t('viewer.log.change', {
        // A typed field's entry names the field by its key ("fields.vendor" → "vendor"): legible
        // without a per-schema catalogue lookup the log cannot make (docs/03 §3.3.10a).
        field: field.startsWith('fields.')
          ? field.slice('fields.'.length)
          : t(`viewer.details.${field}`),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A stored typed value made a draft its input can hold (docs/03 §3.3.10a): a value the wrong shape
// for its kind is treated as no value, which is also what the server would have refused to store.
function fieldDraftOf(spec: DocumentFieldSpec, raw: unknown): FieldDraft {
  switch (spec.kind) {
    case 'number':
      return {
        kind: 'number',
        value: typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
      };
    case 'date':
      return {
        kind: 'date',
        value: typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null,
      };
    case 'money': {
      const money = moneyValueSchema.safeParse(raw);
      return money.success
        ? { kind: 'money', amount: money.data.amount, currency: money.data.currency }
        : { kind: 'money', amount: null, currency: '' };
    }
    default:
      return { kind: 'string', value: typeof raw === 'string' ? raw : '' };
  }
}

// What a draft sends on Save: the stored shape of its kind, null for an emptied input (= clear
// value and source both), or undefined for one that cannot travel yet — a money with only one of
// its halves is not a fact (docs/03 §3.3.10a).
function patchValueOf(field: FieldDraft): unknown {
  if (field.kind === 'string') {
    const value = field.value.trim();
    return value === '' ? null : value;
  }
  if (field.kind === 'number') return field.value;
  if (field.kind === 'date') return field.value;
  const currency = field.currency.trim().toUpperCase();
  if (field.amount === null && currency === '') return null;
  if (field.amount === null || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { amount: field.amount, currency };
}

// "Changed" for a typed field: nothing equals nothing, scalars compare as themselves, and a money
// compares by its two halves.
function sameFieldValue(a: unknown, b: unknown): boolean {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty && bEmpty;
  if (isRecord(a) && isRecord(b)) {
    const first = moneyValueSchema.safeParse(a);
    const second = moneyValueSchema.safeParse(b);
    return (
      first.success &&
      second.success &&
      first.data.amount === second.data.amount &&
      first.data.currency === second.data.currency
    );
  }
  return a === b;
}

// A typed value formatted for the reader (docs/11 §11.5): Intl dates and currency amounts, strings
// and numbers as they are. The empty string where the value is missing or misshapen, which the
// definition list prints as its em dash.
function formatFieldValue(spec: DocumentFieldSpec, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  switch (spec.kind) {
    case 'string':
      return typeof raw === 'string' ? raw : '';
    case 'number':
      return typeof raw === 'number' ? String(raw) : '';
    case 'date':
      return typeof raw === 'string' ? formatDate(raw) : '';
    case 'money': {
      const money = moneyValueSchema.safeParse(raw);
      if (!money.success) return '';
      try {
        return new Intl.NumberFormat(navigator.language, {
          style: 'currency',
          currency: money.data.currency,
        }).format(money.data.amount);
      } catch {
        return `${money.data.amount} ${money.data.currency}`;
      }
    }
    case 'table':
      return '';
  }
}

function placeOf(city: string | null, country: string | null): string {
  return [city, displayCountry(country)].filter((part) => part !== null && part !== '').join(', ');
}

// The home screen, filtered — the address a filter already lives at (docs/11 §11.3). Used where no
// browse screen exists for the facet: a kind, and a place.
function documentsHref(filters: Record<string, string>): string {
  return `/documents?${new URLSearchParams(filters).toString()}`;
}

// A place is one fact written in two boxes, and each box is a way in: the city inside its country,
// because "Bar" is a town in three of them, and the country on its own, because "everything from
// Montenegro" is a question people ask (docs/11 §11.5). Whichever half is missing is simply not
// printed, exactly as `placeOf` prints it.
function placeWaysIn(
  city: string | null,
  country: string | null,
): Array<{ id: string; node: ReactNode }> {
  const ways: Array<{ id: string; node: ReactNode }> = [];
  if (city !== null && city !== '') {
    ways.push({
      id: 'city',
      node: (
        <Link href={documentsHref(country === null ? { city } : { country, city })}>{city}</Link>
      ),
    });
  }
  const countryName = displayCountry(country);
  if (country !== null && countryName !== null && countryName !== '') {
    ways.push({
      id: 'country',
      node: <Link href={documentsHref({ country })}>{countryName}</Link>,
    });
  }
  return ways;
}

// The year a `yyyy-mm-dd` carries, or null when there is no date: the four leading digits, never a
// Date, for the reason `formatDate` gives.
function yearOf(date: string | null): string | null {
  if (date === null) return null;
  const year = date.slice(0, 4);
  return /^\d{4}$/.test(year) ? year : null;
}

// The kinds the analysis read, each once and in the order it read them — the "read as" line for the
// kind row, which shows the same de-duplicated set the row itself does.
function distinctKinds(subjects: ReadonlyArray<{ kind: string }>): string {
  return [...new Set(subjects.map((subject) => subject.kind))].join(', ');
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

// The numbers a step answered with, in the order somebody asks them: how long, how much came out,
// what it cost (docs/03 §3.3.18). Only the ones the step actually reported — a missing number is
// not a zero.
function stepCost(event: DocumentEventDto, t: ReturnType<typeof useTranslations>): string[] {
  const { payload } = event;
  const parts: string[] = [];
  if (payload.durationMs !== undefined) {
    parts.push(
      payload.durationMs < 1000
        ? t('viewer.log.cost.ms', { value: payload.durationMs })
        : t('viewer.log.cost.seconds', { value: Math.round(payload.durationMs / 100) / 10 }),
    );
  }
  if (payload.pages !== undefined) parts.push(t('viewer.log.cost.pages', { value: payload.pages }));
  if (payload.chars !== undefined) parts.push(t('viewer.log.cost.chars', { value: payload.chars }));
  if (payload.ocrUsed === true) parts.push(t('viewer.log.cost.ocr'));
  // Two engines write the same field now, and which one wrote a bad result is the first question.
  if (payload.transcribed === true) parts.push(t('viewer.log.cost.transcribed'));
  if (payload.promptTokens !== undefined || payload.completionTokens !== undefined) {
    parts.push(
      t('viewer.log.cost.tokens', {
        prompt: payload.promptTokens ?? 0,
        completion: payload.completionTokens ?? 0,
      }),
    );
  }
  return parts;
}

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
  const events = useQuery({
    queryKey: documentKeys.events(documentId),
    queryFn: () => documentApi.events(documentId),
  });

  const latest = new Map<string, DocumentEventDto>();
  for (const event of events.data?.items ?? []) {
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
