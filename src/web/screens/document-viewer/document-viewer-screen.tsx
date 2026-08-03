'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
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
  type DocumentStep,
} from '../../../shared/contracts/documents';
import type { StepStatus } from '../../../shared/contracts/enums';
import { categoryApi, categoryKeys } from '../../entities/category';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { documentApi, documentFiles, documentKeys } from '../../entities/document';
import { useErrorMessage, formatBytes } from '../../shared/lib';

// The viewer refreshes while the pipeline is still working on this document (docs/10 §10.5).
const LIVE_REFRESH_MS = 5000;

// The open tab is the last segment of the address (docs/11 §11.5), so a link to a document can be a
// link to its text.
const VIEWER_TABS = ['preview', 'text', 'details'] as const;
export type ViewerTab = (typeof VIEWER_TABS)[number];

export function isViewerTab(value: string): value is ViewerTab {
  return VIEWER_TABS.some((tab) => tab === value);
}

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

  const categories = useQuery({ queryKey: categoryKeys.all, queryFn: categoryApi.list });
  const collections = useQuery({ queryKey: collectionKeys.all, queryFn: collectionApi.list });

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
                children: (
                  <PreviewPane document={detail} markdown={markdown.data?.markdown ?? null} />
                ),
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
                key: 'details',
                label: t('viewer.tabs.details'),
                children: (
                  <DetailsPane
                    document={detail}
                    categories={categories.data?.items ?? []}
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
              <Tooltip
                title={
                  detail.availability === 'UNAVAILABLE'
                    ? t('viewer.downloadUnavailable')
                    : undefined
                }
              >
                <Button
                  type="primary"
                  block
                  disabled={detail.availability === 'UNAVAILABLE'}
                  href={documentFiles.source(detail.id)}
                >
                  {t('viewer.download')}
                </Button>
              </Tooltip>

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

// The document itself, as the browser can show it (docs/10 §10.8): a PDF in an <object>, an image
// as its full-size preview, text as rendered Markdown.
function PreviewPane({
  document,
  markdown,
}: {
  document: DocumentDetailDto;
  markdown: string | null;
}) {
  const t = useTranslations();

  if (document.mimeType.startsWith('image/') && document.hasPreview) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- an API route that 302s to a signed URL.
      <img
        src={documentFiles.preview(document.id)}
        alt={document.title}
        style={{ maxWidth: '100%' }}
      />
    );
  }

  const hasPdf = document.mimeType === 'application/pdf' || document.steps.canonical === 'DONE';
  if (hasPdf && document.availability === 'AVAILABLE') {
    return (
      <object
        data={documentFiles.canonical(document.id)}
        type="application/pdf"
        style={{ width: '100%', height: '70vh' }}
        aria-label={t('viewer.tabs.preview')}
      >
        {/* Whatever the browser cannot render inline, it can still download. */}
        <a href={documentFiles.source(document.id)}>{t('viewer.download')}</a>
      </object>
    );
  }

  if (markdown !== null && markdown !== '') return <RenderedMarkdown markdown={markdown} />;
  return <Empty description={t('viewer.noPreview')} />;
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
function RenderedMarkdown({ markdown }: { markdown: string }) {
  return (
    <Typography>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {markdown}
      </Markdown>
    </Typography>
  );
}

type MetaChange = {
  title?: string;
  categoryId?: string | null;
  languages?: string[];
  country?: string | null;
  city?: string | null;
  reset?: ResettableField[];
};

// What a person may correct, while they are correcting it. Held apart from the document so that
// nothing is sent until Save: a select that writes on every keystroke turns a glance into an edit.
type Draft = {
  categoryId: string | null;
  languages: string[];
  country: string | null;
  city: string;
};

// Everything about the document that is not the document, in one list: what the file is, what the
// pipeline made of it, where its bytes live — and, behind an Edit button, a way to correct the parts
// a machine guessed (docs/11 §11.5).
function DetailsPane({
  document,
  categories,
  onSave,
  saving,
}: {
  document: DocumentDetailDto;
  categories: Array<{ id: string; slug: string; name: string }>;
  onSave: (input: MetaChange) => void;
  saving: boolean;
}) {
  const t = useTranslations();
  const size = useMemo(() => formatBytes(document.sizeBytes), [document.sizeBytes]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reset, setReset] = useState<ResettableField[]>([]);
  const editing = draft !== null;

  const startEditing = (): void => {
    setReset([]);
    setDraft({
      categoryId: document.category?.id ?? null,
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
  // told it was a reset rather than a choice, so a reset category becomes AUTO again and the next
  // run may classify it (docs/03 §3.3.10).
  const resetFields = (fields: ResettableField[]): void => {
    if (draft === null) return;
    setReset((chosen) => [...new Set([...chosen, ...fields])]);
    const next = { ...draft };
    if (fields.includes('category')) next.categoryId = autoCategory?.id ?? null;
    if (fields.includes('languages')) next.languages = document.auto.languages ?? [];
    if (fields.includes('country')) next.country = document.auto.country ?? null;
    if (fields.includes('city')) next.city = document.auto.city ?? '';
    setDraft(next);
  };

  // Only what actually changed: an untouched field must not be sent, or every save would count as a
  // manual assignment and a category the classifier chose would silently become a person's choice
  // (docs/03 §3.3.10).
  const save = (): void => {
    if (draft === null) return;
    const change: MetaChange = {};
    // A field that was reset travels as a reset, never as a value: sending the same value by hand
    // would mark it as somebody's choice, which is the opposite of what was asked for.
    if (!reset.includes('category') && draft.categoryId !== (document.category?.id ?? null)) {
      change.categoryId = draft.categoryId;
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
  // and the languages with the parse, the place and the category with the AI step. A field whose
  // step has not settled is a field whose value is provisional, and it says so rather than showing
  // an em dash that reads as "there is none".
  const state = (...steps: DocumentStep[]): 'PENDING' | 'RUNNING' | undefined => {
    const statuses = steps.map((step) => document.steps[step]);
    if (statuses.includes('RUNNING')) return 'RUNNING';
    return statuses.includes('PENDING') ? 'PENDING' : undefined;
  };

  // "read as X" — shown only where the machine's answer and the current one differ, because
  // repeating a value that nobody changed is noise (docs/03 §3.3.10).
  const wasRead = (auto: string | null | undefined, current: string): ReactNode =>
    auto === null || auto === undefined || auto === '' || auto === current
      ? undefined
      : t('viewer.details.auto', { value: auto });

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

  const autoCategory = categories.find((category) => category.slug === document.auto.categorySlug);
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
          { label: t('viewer.details.mime'), value: document.mimeType },
          {
            label: t('viewer.details.category'),
            value:
              draft !== null ? (
                withReset(
                  ['category'],
                  <Select
                    allowClear
                    className="legere-field"
                    placeholder={t('viewer.category')}
                    aria-label={t('viewer.category')}
                    value={draft.categoryId ?? undefined}
                    onChange={(categoryId?: string) =>
                      setDraft({ ...draft, categoryId: categoryId ?? null })
                    }
                    options={categories.map((category) => ({
                      value: category.id,
                      label: category.name,
                    }))}
                  />,
                  document.auto.categorySlug !== undefined &&
                    document.auto.categorySlug !== null &&
                    (autoCategory?.id ?? null) !== draft.categoryId,
                )
              ) : (
                <Space size={4} wrap>
                  {document.category?.name ?? ''}
                  {/* Chosen by the classifier and not confirmed by anybody since (03 §3.3.10). */}
                  {document.categorySource === 'AUTO' && <Tag color="blue">{t('viewer.auto')}</Tag>}
                </Space>
              ),
            pending: state('categorization'),
            note: wasRead(
              autoCategory?.name ?? document.auto.categorySlug,
              document.category?.name ?? '',
            ),
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
            pending: state('markdown', 'categorization'),
            note: wasRead(autoLanguages, document.languages.map(displayLanguage).join(', ')),
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
            pending: state('categorization'),
            note: wasRead(autoPlace, placeOf(document.city, document.country)),
          },
          {
            label: t('viewer.details.hash'),
            value: (
              <Typography.Text code copyable={{ text: document.contentHash }}>
                {document.contentHash.slice(0, 12)}…
              </Typography.Text>
            ),
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
          // Where the bytes are. One row per place, labelled by the library holding it: a card of
          // its own made it look like a section of the document rather than one more fact about it.
          ...(document.fileRefs.length === 0
            ? [
                {
                  label: t('viewer.details.locations'),
                  value: (
                    <Typography.Text type="secondary">
                      {t('viewer.details.noLocations')}
                    </Typography.Text>
                  ),
                },
              ]
            : document.fileRefs.map((ref) => ({
                label: ref.libraryName,
                value: (
                  <Space size={4} wrap>
                    <Typography.Text code>{ref.path}</Typography.Text>
                    {ref.status === 'MISSING' && (
                      <Tag color="default">{t('documents.badges.unavailable')}</Tag>
                    )}
                  </Space>
                ),
              }))),
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
    </Space>
  );
}

function placeOf(city: string | null, country: string | null): string {
  return [city, displayCountry(country)].filter((part) => part !== null && part !== '').join(', ');
}

// The tags already on the document, plus whatever the pipeline read, each with its name spelled
// out. Anything else can still be typed — the field takes free tags.
function languageOptions(
  current: string[],
  auto: string[],
): Array<{ value: string; label: string }> {
  return [...new Set([...current, ...auto])].map((tag) => ({
    value: tag,
    label: `${displayLanguage(tag)} (${tag})`,
  }));
}

function statusColor(status: StepStatus): string {
  if (status === 'RUNNING') return 'processing';
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'PENDING') return 'blue';
  return 'default';
}

// Every ISO 3166-1 alpha-2 code that Intl recognises, named in the reader's own language. Built by
// asking Intl about all 676 two-letter combinations and keeping the ones it has a name for: a list
// of countries is data that goes out of date, and this one cannot.
const COUNTRY_OPTIONS: Array<{ value: string; label: string }> = (() => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const options: Array<{ value: string; label: string }> = [];
  for (const first of letters) {
    for (const second of letters) {
      const code = `${first}${second}`;
      const name = displayCountry(code);
      if (name !== null && name !== code) options.push({ value: code, label: name });
    }
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
})();

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
