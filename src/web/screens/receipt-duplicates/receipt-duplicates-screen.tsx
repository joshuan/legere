'use client';

import { ReloadOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Empty, Modal, Radio, Space, Spin, Tabs, Tag, Typography } from 'antd';
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
import { PageHeader, QueryError } from '../../shared/ui';
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
  const [tab, setTab] = useState('review');
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
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Space wrap>
            <Link href="/receipts">
              <Button>{tr('back')}</Button>
            </Link>
            <Link href="/receipts?compare=1">
              <Button>{t('selectManually')}</Button>
            </Link>
            <Button
              aria-label={t('refresh')}
              icon={<ReloadOutlined aria-hidden />}
              onClick={refresh}
              loading={active.isFetching}
            >
              {t('refresh')}
            </Button>
          </Space>
        }
      />
      {result !== null && (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setResult(null)}
          title={t('saved')}
          description={
            <Space wrap>
              {t(`actions.${result.action}`)}
              {result.resultId !== null && (
                <Link href={`/receipts/${result.resultId}`}>{t('openResult')}</Link>
              )}
              <Button type="link" onClick={() => setTab('history')}>
                {t('history')}
              </Button>
            </Space>
          }
        />
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
              <Space orientation="vertical" size={20} style={{ width: '100%' }}>
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
                          <div>
                            <Typography.Title level={2}>{t(`kinds.${pair.kind}`)}</Typography.Title>
                            <Typography.Paragraph type="secondary">
                              {t('reviewHint')}
                            </Typography.Paragraph>
                          </div>
                          <Space wrap>
                            <Tag>{t('loaded', { count: manual ? 1 : available.length })}</Tag>
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
                          </Space>
                        </div>
                        <div>
                          <Typography.Text strong>{t('matches')}</Typography.Text>
                          <div className="receipt-review-tags">
                            {pair.reasons.length === 0 ? (
                              <Typography.Text type="secondary">{t('noMatches')}</Typography.Text>
                            ) : (
                              pair.reasons.map((reason) => (
                                <Tag key={reason} color="success">
                                  {t(`facts.${reason}`)}
                                </Tag>
                              ))
                            )}
                          </div>
                        </div>
                        {pair.conflicts.length > 0 && (
                          <Alert
                            type="warning"
                            showIcon
                            title={t('conflicts')}
                            description={pair.conflicts
                              .map((conflict) => t(`facts.${conflict}`))
                              .join(' · ')}
                          />
                        )}
                        <div className="receipt-comparison-grid">
                          <ReceiptComparison key={pair.first.id} receipt={pair.first} side={1} />
                          <ReceiptComparison key={pair.second.id} receipt={pair.second} side={2} />
                        </div>
                        <div className="receipt-review-decision">
                          <div>
                            <Typography.Title level={3}>{t('decision')}</Typography.Title>
                            <Typography.Paragraph type="secondary">
                              {t('preserveHint')}
                            </Typography.Paragraph>
                          </div>
                          <Space wrap>
                            <Button onClick={() => choose('KEEP_FIRST')}>
                              {t('actions.KEEP_FIRST')}
                            </Button>
                            <Button onClick={() => choose('KEEP_SECOND')}>
                              {t('actions.KEEP_SECOND')}
                            </Button>
                            <Button onClick={() => choose('DISMISS')}>
                              {t('actions.DISMISS')}
                            </Button>
                          </Space>
                          <div className="receipt-review-merge">
                            <Typography.Text strong>{t('mergeHint')}</Typography.Text>
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
                            <Button
                              type="primary"
                              disabled={pair.mergeBlocked !== null}
                              onClick={() => choose('MERGE')}
                            >
                              {t('actions.MERGE')}
                            </Button>
                          </div>
                        </div>
                      </>
                    ) : !active.isError ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          suggestions.hasNextPage && !manual ? t('scanMore') : t('empty')
                        }
                      />
                    ) : null}
                    {!manual && suggestions.hasNextPage && (
                      <Button
                        loading={suggestions.isFetchingNextPage}
                        onClick={() => void suggestions.fetchNextPage()}
                      >
                        {t('continueScan')}
                      </Button>
                    )}
                  </>
                )}
              </Space>
            ),
          },
          { key: 'history', label: t('history'), children: <ReviewHistory /> },
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
