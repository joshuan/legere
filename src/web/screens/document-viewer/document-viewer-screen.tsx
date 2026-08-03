'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
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
import { DefinitionList } from '../../shared/ui/definition-list';
import { Fragment, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  DOCUMENT_STEPS,
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

// /documents/:id (docs/11 §11.5): read the document, and manage the little that belongs to it.
export function DocumentViewerScreen({ id, isAdmin = false }: { id: string; isAdmin?: boolean }) {
  const t = useTranslations();
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
    mutationFn: (input: { title?: string; categoryId?: string | null }) =>
      documentApi.update(id, input),
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
        <Card>
          <Tabs
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
                children: <DetailsPane document={detail} />,
              },
            ]}
          />
        </Card>
      </Col>

      <Col xs={24} lg={8}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Typography.Title
                level={4}
                style={{ margin: 0 }}
                // Inline edit: the title is the one piece of metadata everyone fixes (docs/11 §11.5).
                editable={{
                  onChange: (title) => {
                    if (title.trim() !== '' && title !== detail.title) update.mutate({ title });
                  },
                  triggerType: ['icon', 'text'],
                }}
              >
                {detail.title}
              </Typography.Title>

              <Space wrap>
                <Select
                  allowClear
                  style={{ minWidth: 200 }}
                  placeholder={t('viewer.category')}
                  aria-label={t('viewer.category')}
                  loading={categories.isPending}
                  value={detail.category?.id ?? undefined}
                  onChange={(categoryId?: string) =>
                    update.mutate({ categoryId: categoryId ?? null })
                  }
                  options={(categories.data?.items ?? []).map((category) => ({
                    value: category.id,
                    label: category.name,
                  }))}
                />
                {detail.categorySource === 'AUTO' && <Tag color="blue">{t('viewer.auto')}</Tag>}
              </Space>

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
          document.steps.markdown === 'FAILED' ? t('viewer.textFailed') : t('viewer.noText')
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

function DetailsPane({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const size = useMemo(() => formatBytes(document.sizeBytes), [document.sizeBytes]);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <DefinitionList
        items={[
          { label: t('viewer.details.size'), value: size, emphasis: true },
          { label: t('viewer.details.pages'), value: document.pageCount, emphasis: true },
          { label: t('viewer.details.mime'), value: document.mimeType },
          {
            label: t('viewer.details.languages'),
            // Empty is honest: there was too little text to tell (docs/03 §3.3.10).
            value: document.languages.map((language) => displayLanguage(language)).join(', '),
          },
          {
            label: t('viewer.details.place'),
            value: [document.city, displayCountry(document.country)]
              .filter((part) => part !== null && part !== '')
              .join(', '),
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
          },
        ]}
      />

      <Card size="small" title={t('viewer.details.locations')}>
        {document.fileRefs.length === 0 ? (
          <Typography.Text type="secondary">{t('viewer.details.noLocations')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {document.fileRefs.map((ref) => (
              <Space key={`${ref.libraryId}:${ref.path}`} wrap>
                <Tag>{ref.libraryName}</Tag>
                <Typography.Text code>{ref.path}</Typography.Text>
                {ref.status === 'MISSING' && (
                  <Tag color="default">{t('documents.badges.unavailable')}</Tag>
                )}
              </Space>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}

function statusColor(status: StepStatus): string {
  if (status === 'DONE') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'PENDING') return 'blue';
  return 'default';
}

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
