'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Space, Spin, Switch, Tabs, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { analysisSettingsApi, queueKeys } from '../../entities/queue';
import { processingApi, processingKeys } from '../../entities/processing';
import { useErrorMessage } from '../../shared/lib';
import {
  adminProcessingHref,
  isAdminProcessingTab,
  type AdminProcessingTab,
} from '../../entities/processing';
import { ReceiptProcessingTab } from './receipt-processing-tab';
import { OverviewTab, ControlPlaneState, QueueCard } from './ui/overview';
import { PipelineSettings, PipelineTable } from './ui/pipeline';
import { ServicesTab } from './ui/services';
import { FailuresTable } from './ui/failures';

const REFRESH_MS = 5_000;

const SERVICES_REFRESH_MS = 60_000;

export function ProcessingDashboard({ tab = 'overview' }: { tab?: AdminProcessingTab }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [pendingTab, setPendingTab] = useState<{
    from: AdminProcessingTab;
    to: AdminProcessingTab;
  } | null>(null);
  const active = pendingTab?.from === tab ? pendingTab.to : tab;

  // Overview, Pipeline and Services are three projections of this one read model. In particular,
  // no client-owned step/service map can drift from the worker topology.
  const snapshot = useQuery({
    queryKey: processingKeys.snapshot,
    queryFn: processingApi.snapshot,
    refetchInterval: live ? REFRESH_MS : false,
  });

  const failures = useInfiniteQuery({
    queryKey: processingKeys.failures,
    queryFn: ({ pageParam }) => processingApi.failures(pageParam === '' ? null : pageParam),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: active === 'failures',
    refetchInterval: live && active === 'failures' ? REFRESH_MS : false,
  });

  const analysis = useQuery({
    queryKey: queueKeys.analysis,
    queryFn: analysisSettingsApi.read,
    enabled: active === 'pipeline',
  });
  const [languageDraft, setLanguageDraft] = useState<{ value: string | undefined } | null>(null);
  const language =
    languageDraft === null
      ? analysis.data?.language === ''
        ? undefined
        : analysis.data?.language
      : languageDraft.value;
  const saveAnalysis = useMutation({
    mutationFn: analysisSettingsApi.save,
    onSuccess: () => {
      void message.success(t('admin.queue.settings.saved'), 2);
      void queryClient.invalidateQueries({ queryKey: queueKeys.analysis });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    void queryClient.invalidateQueries({ queryKey: processingKeys.failures });
    void queryClient.invalidateQueries({ queryKey: processingKeys.receipts });
  }, [queryClient]);

  const retry = useMutation({
    mutationFn: processingApi.retry,
    onSuccess: () => {
      void message.success(t('admin.queue.retried'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const reprocess = useMutation({
    mutationFn: processingApi.reprocess,
    onSuccess: (result) => {
      void message.success(t('admin.queue.reprocess.enqueued', { count: result.enqueued }), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const checkServices = useMutation({
    mutationFn: processingApi.checkServices,
    onSuccess: () => {
      void message.success(t('admin.queue.services.checked'), 2);
      void queryClient.invalidateQueries({ queryKey: processingKeys.snapshot });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const checkServicesNow = checkServices.mutate;
  useEffect(() => {
    if (active !== 'services') return;
    checkServicesNow();
    if (!live) return;
    const timer = window.setInterval(checkServicesNow, SERVICES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, checkServicesNow, live]);

  const data = snapshot.data;
  const failedRecent = (data?.queues ?? []).reduce(
    (total, queue) => total + queue.runtime.failedRecent,
    0,
  );

  const overview = data === undefined ? <Spin /> : <OverviewTab snapshot={data} />;
  const pipeline =
    data === undefined ? (
      <Spin />
    ) : (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <PipelineSettings
          snapshot={data}
          language={language}
          onLanguageChange={(value) => setLanguageDraft({ value })}
          onSaveLanguage={() => saveAnalysis.mutate({ language: language ?? '' })}
          languageReady={analysis.data !== undefined}
          languageSaving={saveAnalysis.isPending}
        />
        <PipelineTable
          snapshot={data}
          onRunAgain={(request) => reprocess.mutate(request)}
          running={reprocess.isPending ? (reprocess.variables ?? null) : null}
        />
      </Space>
    );
  const services =
    data === undefined ? (
      <Spin />
    ) : (
      <ServicesTab
        snapshot={data}
        checking={checkServices.isPending}
        onCheck={() => checkServices.mutate()}
      />
    );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('admin.queue.title')}
        </Typography.Title>
        <Space>
          <Typography.Text type="secondary">{t('admin.queue.autoRefresh')}</Typography.Text>
          <Switch
            checked={live}
            onChange={setLive}
            aria-label={t('admin.queue.autoRefresh')}
            checkedChildren={t('admin.queue.refresh.on')}
            unCheckedChildren={t('admin.queue.refresh.off')}
          />
        </Space>
      </Space>

      {snapshot.isError && <Alert type="error" showIcon message={describeError(snapshot.error)} />}
      {data !== undefined && <ControlPlaneState snapshot={data} />}

      <Tabs
        activeKey={active}
        onChange={(key) => {
          if (!isAdminProcessingTab(key)) return;
          setPendingTab({ from: tab, to: key });
          router.replace(adminProcessingHref(key));
        }}
        items={[
          { key: 'overview', label: t('admin.queue.tabs.overview'), children: overview },
          {
            key: 'receipts',
            label: t('admin.queue.tabs.receipts'),
            children:
              data === undefined ? (
                <Spin />
              ) : (
                <ReceiptProcessingTab snapshot={data} active={active === 'receipts'} live={live}>
                  {data.queues
                    .filter((row) => row.name === 'receipt-process')
                    .map((row) => (
                      <QueueCard key={row.name} row={row} snapshot={data} />
                    ))}
                </ReceiptProcessingTab>
              ),
          },
          { key: 'pipeline', label: t('admin.queue.tabs.pipeline'), children: pipeline },
          { key: 'services', label: t('admin.queue.tabs.services'), children: services },
          {
            key: 'failures',
            label: (
              <Space size={6}>
                {t('admin.queue.tabs.failures')}
                {failedRecent > 0 && <Tag color="red">{failedRecent}</Tag>}
              </Space>
            ),
            children: (
              <FailuresTable
                jobs={failures.data?.pages.flatMap((page) => page.items) ?? []}
                loading={failures.isPending}
                hasMore={failures.hasNextPage}
                loadingMore={failures.isFetchingNextPage}
                onLoadMore={() => void failures.fetchNextPage()}
                retrying={retry.isPending ? (retry.variables ?? null) : null}
                onRetry={(jobId) => retry.mutate(jobId)}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}
