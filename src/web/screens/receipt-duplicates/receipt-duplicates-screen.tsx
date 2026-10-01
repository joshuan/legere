'use client';

import {
  ArrowLeftOutlined,
  CloseOutlined,
  ReloadOutlined,
  SelectOutlined,
} from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Empty, Modal, Radio, Space, Spin, Tabs, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  receiptPairQuerySchema,
  type ReceiptDuplicatePair,
  type ReceiptReviewAction,
  type ReceiptReviewDto,
  type ResolveReceiptPair,
} from '../../../shared/contracts/receipt-duplicates';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { useErrorMessage } from '../../shared/lib';
import { QueryError } from '../../shared/ui';
import { ReceiptComparison } from './receipt-comparison';
import { ReviewHistory } from './review-history';

function keyOf(pair: ReceiptDuplicatePair): string {
  return `${pair.first.id}:${pair.second.id}:${pair.revision}`;
}

export function ReceiptDuplicatesScreen() {
  const t = useTranslations('receiptDuplicates');
  const tr = useTranslations('receipts');
  const describeError = useErrorMessage();
  const client = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const manual = params.has('firstId') || params.has('secondId');
  const parsed = receiptPairQuerySchema.safeParse({
    firstId: params.get('firstId'),
    secondId: params.get('secondId'),
  });
  const query = parsed.success ? parsed.data : null;
  const [tab, setTab] = useState(params.get('tab') === 'history' ? 'history' : 'review');
  const [reverse, setReverse] = useState(false);
  const [pairIndex, setPairIndex] = useState(0);
  const [command, setCommand] = useState<ResolveReceiptPair | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const [result, setResult] = useState<ReceiptReviewDto | null>(null);
  const suggestions = useInfiniteQuery({
    queryKey: receiptKeys.duplicates,
    queryFn: ({ pageParam }) => receiptApi.duplicates(pageParam),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !manual && tab === 'review',
  });
  const comparison = useQuery({
    queryKey: receiptKeys.comparison(query),
    queryFn: () => {
      if (query === null) throw new Error('Invalid receipt pair');
      return receiptApi.compare(query);
    },
    enabled: query !== null && manual,
  });
  const candidates = suggestions.data?.pages.flatMap((page) => page.items) ?? [];
  const available = candidates.filter((item) => keyOf(item) !== finished);
  const position = Math.min(pairIndex, Math.max(0, available.length - 1));
  const pair = manual
    ? comparison.data !== undefined && keyOf(comparison.data) !== finished
      ? comparison.data
      : undefined
    : available[position];
  const resolve = useMutation({
    mutationFn: receiptApi.resolve,
    onSuccess: async (review) => {
      setFinished(keyOf(review.pair));
      setResult(review);
      setCommand(null);
      setReverse(false);
      setPairIndex(0);
      if (manual) router.replace('/receipts/duplicates');
      await client.invalidateQueries({ queryKey: receiptKeys.all });
    },
  });
  function choose(action: ReceiptReviewAction) {
    if (pair === undefined) return;
    resolve.reset();
    setCommand({
      operationId: crypto.randomUUID(),
      firstId: pair.first.id,
      secondId: pair.second.id,
      revision: pair.revision,
      action,
      reverse: action === 'MERGE' && reverse,
    });
  }
  const refresh = () => {
    setFinished(null);
    void client.invalidateQueries({ queryKey: receiptKeys.all });
  };
  const active = manual ? comparison : suggestions;
  return (
    <div className="receipt-duplicate-screen">
      <header className="receipt-review-toolbar">
        <Typography.Title level={1}>{t('title')}</Typography.Title>
        <div className="receipt-review-toolbar-actions">
          <Link href="/receipts" aria-label={tr('back')} title={tr('back')}>
            <Button icon={<ArrowLeftOutlined aria-hidden />}>
              <span className="receipt-toolbar-text">{tr('back')}</span>
            </Button>
          </Link>
          <Link
            href="/receipts?compare=1"
            aria-label={t('selectManually')}
            title={t('selectManually')}
          >
            <Button icon={<SelectOutlined aria-hidden />}>
              <span className="receipt-toolbar-text">{t('selectManually')}</span>
            </Button>
          </Link>
          <Button
            aria-label={t('refresh')}
            title={t('refresh')}
            icon={<ReloadOutlined aria-hidden />}
            onClick={refresh}
            loading={active.isFetching}
          />
        </div>
      </header>
      {result !== null && (
        <div className="receipt-review-saved" role="status">
          <span>{t('saved')}</span>
          {result.resultId !== null && (
            <Link href={`/receipts/${result.resultId}`}>{t('openResult')}</Link>
          )}
          <Button
            type="text"
            aria-label={t('closeNotice')}
            icon={<CloseOutlined aria-hidden />}
            onClick={() => setResult(null)}
          />
        </div>
      )}
      <Tabs
        activeKey={tab}
        onChange={(next) => {
          setTab(next);
          if (next === 'review') setFinished(null);
        }}
        destroyOnHidden
        items={[
          {
            key: 'review',
            label: t('review'),
            children: (
              <div className="receipt-review-panel">
                {manual && query === null ? (
                  <Alert type="error" title={t('invalidPair')} />
                ) : (
                  <>
                    {active.isError && <QueryError error={active.error} retry={active.refetch} />}
                    {active.isLoading ? (
                      <div className="receipt-review-loading">
                        <Spin />
                      </div>
                    ) : pair !== undefined ? (
                      <>
                        <div className="receipt-review-intro">
                          <Typography.Title level={2} title={t('reviewHint')}>
                            {t(`kinds.${pair.kind}`)}
                          </Typography.Title>
                          <Space>
                            <Typography.Text type="secondary">
                              {t('pairPosition', {
                                current: position + 1,
                                count: manual ? 1 : available.length,
                              })}
                            </Typography.Text>
                            {!manual && available.length > 1 && (
                              <Button
                                onClick={() => {
                                  setPairIndex((position + 1) % available.length);
                                  setReverse(false);
                                }}
                              >
                                {t('nextPair')}
                              </Button>
                            )}
                            {!manual && suggestions.hasNextPage && (
                              <Button
                                aria-label={t('continueScan')}
                                title={t('continueScan')}
                                icon={<ReloadOutlined aria-hidden />}
                                loading={suggestions.isFetchingNextPage}
                                onClick={() => void suggestions.fetchNextPage()}
                              >
                                <span className="receipt-toolbar-text">{t('continueScan')}</span>
                              </Button>
                            )}
                          </Space>
                        </div>
                        <ReceiptComparison key={keyOf(pair)} pair={pair} />
                        <footer className="receipt-review-decision" aria-label={t('decision')}>
                          <div className="receipt-review-decision-actions">
                            <Button onClick={() => choose('KEEP_FIRST')}>
                              {t('actions.KEEP_FIRST')}
                            </Button>
                            <Button onClick={() => choose('KEEP_SECOND')}>
                              {t('actions.KEEP_SECOND')}
                            </Button>
                            <Button onClick={() => choose('DISMISS')}>
                              {t('actions.DISMISS')}
                            </Button>
                            <Button
                              type="primary"
                              disabled={pair.mergeBlocked !== null}
                              onClick={() => choose('MERGE')}
                            >
                              {t('actions.MERGE')}
                            </Button>
                          </div>
                          <div className="receipt-review-merge">
                            <Typography.Text type="secondary">{t('pageOrder')}</Typography.Text>
                            <Radio.Group
                              value={reverse}
                              aria-label={t('pageOrder')}
                              onChange={(event) => setReverse(event.target.value === true)}
                            >
                              <Radio value={false}>{t('orderFirst')}</Radio>
                              <Radio value={true}>{t('orderSecond')}</Radio>
                            </Radio.Group>
                            {pair.mergeBlocked !== null && (
                              <Typography.Text type="warning">
                                {t(`mergeBlocked.${pair.mergeBlocked}`)}
                              </Typography.Text>
                            )}
                          </div>
                        </footer>
                      </>
                    ) : !active.isError ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          suggestions.hasNextPage && !manual ? t('scanMore') : t('empty')
                        }
                      />
                    ) : null}
                    {!manual && pair === undefined && suggestions.hasNextPage && (
                      <Button
                        loading={suggestions.isFetchingNextPage}
                        onClick={() => void suggestions.fetchNextPage()}
                      >
                        {t('continueScan')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            ),
          },
          {
            key: 'history',
            label: t('history'),
            children: (
              <div className="receipt-review-history-scroll">
                <ReviewHistory />
              </div>
            ),
          },
        ]}
      />
      <Modal
        open={command !== null}
        title={command === null ? '' : t(`actions.${command.action}`)}
        okText={t('confirm')}
        cancelText={t('cancel')}
        confirmLoading={resolve.isPending}
        cancelButtonProps={{ disabled: resolve.isPending }}
        closable={!resolve.isPending}
        mask={{ closable: !resolve.isPending }}
        keyboard={!resolve.isPending}
        onCancel={() => setCommand(null)}
        onOk={() => {
          if (command !== null) resolve.mutate(command);
        }}
      >
        {command !== null && (
          <Typography.Paragraph>{t(`confirmations.${command.action}`)}</Typography.Paragraph>
        )}
        {command?.action === 'MERGE' && (
          <Typography.Paragraph>
            {t(command.reverse ? 'orderSecond' : 'orderFirst')}
          </Typography.Paragraph>
        )}
        {resolve.isError && <Alert type="error" showIcon title={describeError(resolve.error)} />}
      </Modal>
    </div>
  );
}
