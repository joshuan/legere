'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import {
  LeftOutlined,
  RightOutlined,
  MinusOutlined,
  PlusOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { DocumentDetailDto } from '../../../../shared/contracts/documents';
import {
  OCR_PROVIDERS,
  type OcrElement,
  type OcrProviderId,
  type OcrResult,
  type StartOcrRequest,
} from '../../../../shared/contracts/page-ocr';
import {
  documentOcrApi,
  documentApi,
  documentKeys,
  DocumentImage,
} from '../../../entities/document';
import { QueryError } from '../../../shared/ui';
import { useErrorMessage } from '../../../shared/lib';
import styles from './recognition.module.css';

const names: Record<OcrProviderId, string> = {
  'google-document-ai': 'Google Document AI',
  'yandex-vision': 'Yandex Vision',
};

export function RecognitionPane({
  document,
  isAdmin,
  active,
}: {
  document: DocumentDetailDto;
  isAdmin: boolean;
  active: boolean;
}) {
  const t = useTranslations('viewer.ocr');
  const describe = useErrorMessage();
  const { message } = App.useApp();
  const client = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [provider, setProvider] = useState<OcrProviderId>('google-document-ai');
  const [providers, setProviders] = useState<OcrProviderId[]>([...OCR_PROVIDERS]);
  const [model, setModel] = useState<'page' | 'table' | 'handwritten'>('page');
  const [force, setForce] = useState(false);
  const [mode, setMode] = useState('boxes');
  const [level, setLevel] = useState('line');
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const pendingRequestRef = useRef<{ key: string; requestId: string } | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const queryKey = ['document-ocr', document.id];
  const runs = useQuery({
    queryKey,
    queryFn: () => documentOcrApi.list(document.id),
    enabled: active,
    refetchInterval: (query) =>
      active &&
      query.state.data?.runs.some((run) =>
        run.pages.some((page) => page.status === 'QUEUED' || page.status === 'RUNNING'),
      )
        ? 3000
        : false,
  });
  const currentRun =
    runId === 'current'
      ? undefined
      : (runs.data?.runs.find((run) => run.id === runId) ?? runs.data?.runs[0]);
  const currentPages = runs.data?.pages ?? [];
  const pages =
    currentRun === undefined
      ? currentPages
      : Array.from(
          new Map(
            currentRun.pages.map((page) => [
              page.pageId,
              { id: page.pageId, number: page.pageNumber },
            ]),
          ).values(),
        );
  const page = pages.find((item) => item.id === pageId) ?? pages[0];
  const available = currentRun?.pages.filter((item) => item.pageId === page?.id) ?? [];
  const result = available.find((item) => item.provider === provider) ?? available[0];
  const resultQuery = useQuery({
    queryKey: ['document-ocr-result', document.id, result?.id],
    queryFn: () => documentOcrApi.result(document.id, result?.id ?? ''),
    enabled: active && result?.status === 'DONE',
  });
  const data = result?.status === 'DONE' ? resultQuery.data : undefined;
  const selectedProviders = providers.filter((id) =>
    runs.data?.providers.some((item) => item.id === id && item.configured),
  );
  const start = useMutation({
    mutationFn: (body: StartOcrRequest) => documentOcrApi.start(document.id, body),
    onSuccess: async (run) => {
      pendingRequestRef.current = null;
      setRunId(run.id);
      setSelected(null);
      await client.invalidateQueries({ queryKey });
    },
    onError: (error: unknown) => void message.error(describe(error)),
  });
  const prepare = useMutation({
    mutationFn: () => documentApi.reprocess(document.id, { steps: ['canonical'] }),
    onSuccess: () => client.invalidateQueries({ queryKey: documentKeys.detail(document.id) }),
    onError: (error: unknown) => void message.error(describe(error)),
  });
  const retry = useMutation({
    mutationFn: () => documentOcrApi.retry(document.id, currentRun?.id ?? ''),
    onSuccess: () => client.invalidateQueries({ queryKey }),
    onError: (error: unknown) => void message.error(describe(error)),
  });
  const recognize = (all: boolean) => {
    if (page === undefined) return;
    const body = {
      providers: selectedProviders,
      yandexModel: model,
      force,
      ...(all ? {} : { pageIds: [page.id] }),
    };
    const key = JSON.stringify(body);
    if (pendingRequestRef.current?.key !== key)
      pendingRequestRef.current = { key, requestId: crypto.randomUUID() };
    start.mutate({ ...body, requestId: pendingRequestRef.current.requestId });
  };
  const canStart =
    isAdmin &&
    document.steps.canonical === 'DONE' &&
    page !== undefined &&
    selectedProviders.length > 0;
  const pageAt = pages.findIndex((candidate) => candidate.id === page?.id);
  const choosePage = (id: string) => {
    setPageId(id);
    setSelected(null);
  };
  const chooseElement = (id: string, fromImage: boolean) => {
    setSelected(id);
    const container = fromImage ? textRef.current : stageRef.current;
    container
      ?.querySelector(`[data-ocr-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  };
  const visible = data?.elements.filter((element) => element.level === level) ?? [];
  const text = (
    <div className={styles.textPanel} ref={textRef}>
      <div className={styles.textHeader}>
        <Typography.Text strong>{t('recognizedText')}</Typography.Text>
        <Button
          size="small"
          icon={<CopyOutlined />}
          disabled={!data?.fullText}
          aria-label={t('copy')}
          onClick={() => {
            if (data !== undefined)
              void navigator.clipboard
                .writeText(data.fullText)
                .then(() => message.success(t('copied')))
                .catch(() => message.error(t('copyFailed')));
          }}
        />
      </div>
      {data !== undefined && data.fullText.trim() === '' && data.elements.length === 0 && (
        <Empty description={t('emptyPage')} />
      )}
      {data !== undefined && visible.length === 0 && data.fullText.trim() !== '' && (
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
          {data.fullText}
        </Typography.Paragraph>
      )}
      {visible.map((element) => (
        <button
          type="button"
          key={element.id}
          data-ocr-id={element.id}
          className={`${styles.textLine} ${selected === element.id ? styles.selectedLine : ''}`}
          aria-pressed={selected === element.id}
          onClick={() => chooseElement(element.id, false)}
        >
          <span>{element.text}</span>
          {element.confidence !== null && (
            <span className={styles.confidence} title={t('confidenceHint')}>
              {Math.round(element.confidence * 100)}%
            </span>
          )}
        </button>
      ))}
      {data === undefined && (
        <Typography.Paragraph type="secondary">{t('textHint')}</Typography.Paragraph>
      )}
    </div>
  );
  const imageSrc = result?.hasImage
    ? documentOcrApi.artifact(document.id, result.id, 'image')
    : page !== undefined && currentRun === undefined && document.steps.canonical === 'DONE'
      ? documentOcrApi.image(document.id, page.id)
      : null;

  return (
    <div className={styles.root}>
      <Typography.Paragraph type="secondary" className={styles.intro ?? ''}>
        {t('intro')}
      </Typography.Paragraph>
      {runs.isError && <QueryError error={runs.error} retry={runs.refetch} />}
      {runs.isPending && <Spin />}
      {isAdmin && (
        <details className={styles.newRun} open={currentRun === undefined}>
          <summary>{t('newRecognition')}</summary>
          <div className={styles.launch}>
            <Checkbox.Group
              value={providers}
              onChange={(values) => setProviders(OCR_PROVIDERS.filter((id) => values.includes(id)))}
              options={OCR_PROVIDERS.map((id) => ({
                label: names[id],
                value: id,
                disabled: !runs.data?.providers.find((item) => item.id === id)?.configured,
              }))}
            />
            {selectedProviders.includes('yandex-vision') && (
              <Select
                aria-label={t('model')}
                value={model}
                onChange={setModel}
                options={(['page', 'table', 'handwritten'] as const).map((value) => ({
                  value,
                  label: t(`models.${value}`),
                }))}
              />
            )}
            <Checkbox checked={force} onChange={(event) => setForce(event.target.checked)}>
              {t('force')}
            </Checkbox>
            <Space wrap>
              <Button
                type="primary"
                disabled={!canStart || currentRun?.stale === true}
                loading={start.isPending}
                onClick={() => recognize(false)}
              >
                {t('recognizePage')}
              </Button>
              <Button
                disabled={!canStart}
                loading={start.isPending}
                onClick={() => recognize(true)}
              >
                {t('recognizeDocument')}
              </Button>
            </Space>
            <Typography.Text type="secondary">
              {t('sendCount', {
                providers: selectedProviders.length,
                pages: document.pageCount ?? 0,
              })}
            </Typography.Text>
          </div>
        </details>
      )}
      {runs.data?.providers.every((item) => !item.configured) && (
        <Alert
          type="info"
          showIcon
          title={t('notConfigured')}
          description={isAdmin ? t('configureHint') : undefined}
        />
      )}
      {document.steps.canonical !== 'DONE' && (
        <Alert type="info" showIcon title={t('canonicalPending')} />
      )}
      {document.steps.canonical === 'DONE' && runs.data?.pages.length === 0 && (
        <Alert
          type="info"
          showIcon
          title={t('prepareHint')}
          action={
            isAdmin ? (
              <Button size="small" loading={prepare.isPending} onClick={() => prepare.mutate()}>
                {t('preparePages')}
              </Button>
            ) : undefined
          }
        />
      )}
      <div className={styles.toolbar}>
        <Space.Compact>
          <Button
            icon={<LeftOutlined />}
            aria-label={t('previous')}
            disabled={pageAt <= 0}
            onClick={() => {
              const next = pages[pageAt - 1];
              if (next !== undefined) choosePage(next.id);
            }}
          />
          <Select
            aria-label={t('page')}
            value={page?.id ?? null}
            onChange={choosePage}
            style={{ minWidth: 108 }}
            options={pages.map((item) => ({
              value: item.id,
              label: t('pageNumber', { page: item.number }),
            }))}
          />
          <Button
            icon={<RightOutlined />}
            aria-label={t('next')}
            disabled={pageAt < 0 || pageAt >= pages.length - 1}
            onClick={() => {
              const next = pages[pageAt + 1];
              if (next !== undefined) choosePage(next.id);
            }}
          />
        </Space.Compact>
        {runs.data !== undefined && runs.data.runs.length > 0 && (
          <Select
            aria-label={t('history')}
            value={currentRun?.id ?? 'current'}
            onChange={(id) => {
              setRunId(id);
              setSelected(null);
            }}
            className={styles.history ?? ''}
            options={[
              { value: 'current', label: t('currentDocument') },
              ...(runs.data?.runs.map((run) => ({
                value: run.id,
                label: `${new Date(run.createdAt).toLocaleString()}${run.stale ? ` — ${t('oldVersion')}` : ''}`,
              })) ?? []),
            ]}
          />
        )}
        {available.length > 0 && (
          <Select
            aria-label={t('provider')}
            value={result?.provider ?? null}
            onChange={(id: OcrProviderId) => {
              setProvider(id);
              setSelected(null);
            }}
            options={available.map((item) => ({
              value: item.provider,
              label: names[item.provider],
            }))}
          />
        )}
        <Segmented
          aria-label={t('display')}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'original', label: t('original') },
            { value: 'boxes', label: t('boxes') },
            { value: 'text', label: t('overlay') },
          ]}
        />
        <Select
          aria-label={t('granularity')}
          value={level}
          onChange={(value) => {
            setLevel(value);
            setSelected(null);
          }}
          options={[
            { value: 'line', label: t('lines') },
            { value: 'word', label: t('words') },
          ]}
        />
        <Space.Compact>
          <Button
            icon={<MinusOutlined />}
            aria-label={t('zoomOut')}
            disabled={zoom <= 0.5}
            onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
          />
          <Button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
          <Button
            icon={<PlusOutlined />}
            aria-label={t('zoomIn')}
            disabled={zoom >= 4}
            onClick={() => setZoom(Math.min(4, zoom + 0.25))}
          />
        </Space.Compact>
        <Button className={styles.mobileText ?? ''} onClick={() => setDrawer(true)}>
          {t('recognizedText')}
        </Button>
      </div>
      {currentRun?.stale && <Alert type="warning" showIcon title={t('stale')} />}
      {result !== undefined && (
        <div className={styles.resultStatus}>
          <Tag
            color={
              result.status === 'FAILED'
                ? 'error'
                : result.status === 'DONE'
                  ? 'success'
                  : 'processing'
            }
          >
            {t(`status.${result.status}`)}
          </Tag>
          <Typography.Text type="secondary">
            {result.model.split('/').at(-1)}
            {result.durationMs === null
              ? ''
              : ` · ${t('duration', { seconds: (result.durationMs / 1000).toFixed(1) })}`}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('attempts', { count: result.submittedAttempts })}
          </Typography.Text>
          {result.cached && <Typography.Text type="secondary">{t('cached')}</Typography.Text>}
          {result.hasRaw && (
            <a href={documentOcrApi.artifact(document.id, result.id, 'raw')}>{t('rawJson')}</a>
          )}
          {result.status === 'DONE' && (
            <a href={documentOcrApi.artifact(document.id, result.id, 'json')}>{t('json')}</a>
          )}
          {isAdmin && currentRun?.pages.some((item) => item.status === 'FAILED') && (
            <Button size="small" loading={retry.isPending} onClick={() => retry.mutate()}>
              {t('retryFailed')}
            </Button>
          )}
        </div>
      )}
      {result?.error && (
        <Alert
          type={result.status === 'FAILED' ? 'error' : 'warning'}
          showIcon
          title={result.error}
          description={result.submittedAttempts > 0 ? t('mayBeBilled') : undefined}
        />
      )}
      {resultQuery.isError && <QueryError error={resultQuery.error} retry={resultQuery.refetch} />}
      <div className={styles.workspace}>
        <div ref={stageRef} className={styles.stage}>
          {imageSrc === null ? (
            <Empty
              description={
                result?.status === 'RUNNING' || result?.status === 'QUEUED'
                  ? t('preparing')
                  : t('choosePage')
              }
            />
          ) : (
            <div className={styles.paper} style={{ width: `${zoom * 100}%` }}>
              <DocumentImage
                key={imageSrc}
                src={imageSrc}
                alt={t('pageNumber', { page: page?.number ?? 1 })}
                style={{ display: 'block', width: '100%', opacity: mode === 'text' ? 0.45 : 1 }}
              />
              {data !== undefined && mode !== 'original' && (
                <OcrOverlay
                  result={data}
                  elements={visible}
                  selected={selected}
                  text={mode === 'text'}
                  onSelect={(id) => chooseElement(id, true)}
                />
              )}
            </div>
          )}
        </div>
        <div className={styles.desktopText}>{text}</div>
      </div>
      <Drawer
        title={t('recognizedText')}
        open={drawer}
        onClose={() => setDrawer(false)}
        placement="bottom"
        size="large"
      >
        {drawer && text}
      </Drawer>
    </div>
  );
}

export function OcrOverlay({
  result,
  elements,
  selected,
  text,
  onSelect,
}: {
  result: OcrResult;
  elements: OcrElement[];
  selected: string | null;
  text: boolean;
  onSelect: (id: string) => void;
}) {
  const { token } = theme.useToken();
  return (
    <svg className={styles.overlay} viewBox={`0 0 ${result.width} ${result.height}`}>
      {elements.map((element) => {
        const points = element.polygon.map((point) => ({
          x: point.x * result.width,
          y: point.y * result.height,
        }));
        const first = points[0];
        const second = points[1];
        const last = points.at(-1);
        if (first === undefined || second === undefined || last === undefined) return null;
        const width = Math.hypot(second.x - first.x, second.y - first.y);
        const height = Math.hypot(last.x - first.x, last.y - first.y);
        if (width < 0.01 || height < 0.01) return null;
        const transform = `matrix(${(second.x - first.x) / width} ${(second.y - first.y) / width} ${(last.x - first.x) / height} ${(last.y - first.y) / height} ${first.x} ${first.y})`;
        return (
          <g
            key={element.id}
            data-ocr-id={element.id}
            role="button"
            tabIndex={0}
            aria-label={element.text}
            aria-pressed={selected === element.id}
            onClick={() => onSelect(element.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(element.id);
              }
            }}
            className={styles.region}
          >
            <polygon
              points={points.map((point) => `${point.x},${point.y}`).join(' ')}
              fill={text ? '#fff' : selected === element.id ? token.colorPrimaryBg : 'transparent'}
              fillOpacity={text ? 0.92 : 0.18}
              stroke={selected === element.id ? token.colorPrimary : token.colorInfoBorder}
              strokeWidth={selected === element.id ? 2 : 1}
              vectorEffect="non-scaling-stroke"
            />
            {text && (
              <text
                transform={transform}
                y={height * 0.82}
                fontSize={height * 0.82}
                textLength={width}
                lengthAdjust="spacingAndGlyphs"
                fill="#111"
              >
                {element.text.trim()}
              </text>
            )}
            <title>{element.text}</title>
          </g>
        );
      })}
    </svg>
  );
}
