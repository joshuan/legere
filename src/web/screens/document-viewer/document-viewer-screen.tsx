'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
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
import { useMemo, useState } from 'react';
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
import { useErrorMessage } from '../../shared/lib';

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
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              {DOCUMENT_STEPS.map((step) => (
                <Space key={step} align="center">
                  <Tag color={statusColor(detail.steps[step])}>{detail.steps[step]}</Tag>
                  <Typography.Text>{t(`viewer.steps.${step}`)}</Typography.Text>
                </Space>
              ))}

              {detail.processingError !== null && (
                <Typography.Paragraph type="danger" style={{ whiteSpace: 'pre-wrap' }}>
                  {detail.failedStep === null
                    ? detail.processingError
                    : `${detail.failedStep}: ${detail.processingError}`}
                </Typography.Paragraph>
              )}

              {isAdmin && (
                <>
                  <Checkbox.Group
                    value={steps}
                    onChange={(checked) => setSteps(checked.filter(isStep))}
                    options={DOCUMENT_STEPS.map((step) => ({
                      value: step,
                      label: t(`viewer.steps.${step}`),
                    }))}
                  />
                  <Button onClick={() => reprocess.mutate()} loading={reprocess.isPending}>
                    {steps.length === 0
                      ? t('viewer.processing.reprocessAll')
                      : t('viewer.processing.reprocessSelected', { count: steps.length })}
                  </Button>
                </>
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
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('viewer.details.size')}>{size}</Descriptions.Item>
        <Descriptions.Item label={t('viewer.details.pages')}>
          {document.pageCount ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('viewer.details.mime')}>{document.mimeType}</Descriptions.Item>
        <Descriptions.Item label={t('viewer.details.hash')}>
          <Typography.Text code copyable={{ text: document.contentHash }}>
            {document.contentHash.slice(0, 12)}…
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('viewer.details.created')}>
          {new Date(document.createdAt).toLocaleString()}
        </Descriptions.Item>
        <Descriptions.Item label={t('viewer.details.ocr')}>
          {document.ocrUsed ? t('common.yes') : t('common.no')}
        </Descriptions.Item>
      </Descriptions>

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

function isStep(value: unknown): value is DocumentStep {
  return DOCUMENT_STEPS.some((step) => step === value);
}

// Sizes arrive as decimal strings (docs/07 §7.4) and can exceed Number.MAX_SAFE_INTEGER in theory.
function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return `${value} B`;

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit] ?? 'B'}`;
}
