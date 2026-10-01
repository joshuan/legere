'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Modal, Space, Spin, Tag, Typography } from 'antd';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { ReceiptReviewDto } from '../../../shared/contracts/receipt-duplicates';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { useErrorMessage } from '../../shared/lib';
import { QueryError } from '../../shared/ui';

export function ReviewHistory() {
  const t = useTranslations('receiptDuplicates');
  const format = useFormatter();
  const describeError = useErrorMessage();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<ReceiptReviewDto | null>(null);
  const history = useInfiniteQuery({
    queryKey: receiptKeys.reviews,
    queryFn: ({ pageParam }) => receiptApi.reviews(pageParam),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const undo = useMutation({
    mutationFn: receiptApi.undoReview,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: receiptKeys.all });
      setConfirm(null);
    },
  });
  const download = useMutation({
    mutationFn: ({ id, side }: { id: string; side: 0 | 1 }) => receiptApi.reviewOriginal(id, side),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary">{t('historyHint')}</Typography.Paragraph>
      {history.isError && <QueryError error={history.error} retry={history.refetch} />}
      {download.isError && <Alert type="error" showIcon title={describeError(download.error)} />}
      {history.isLoading ? (
        <Spin />
      ) : !history.isError && items.length === 0 ? (
        <Empty description={t('historyEmpty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : null}
      {items.map((review) => (
        <Card key={review.id} size="small">
          <div className="receipt-review-history-head">
            <Space wrap>
              <Typography.Text strong>{t(`actions.${review.action}`)}</Typography.Text>
              {review.undoneAt !== null && <Tag>{t('undone')}</Tag>}
            </Space>
            <Typography.Text type="secondary">
              {format.dateTime(new Date(review.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}{' '}
              · {review.actor.displayName}
            </Typography.Text>
          </div>
          <Typography.Paragraph className="receipt-review-file-names">
            {review.pair.first.fileName} + {review.pair.second.fileName}
          </Typography.Paragraph>
          <Space wrap>
            {review.resultId !== null && review.undoneAt === null && (
              <Link href={`/receipts/${review.resultId}`}>
                <Button>{t('openResult')}</Button>
              </Link>
            )}
            {([0, 1] as const).map((side) => (
              <Button
                key={side}
                loading={
                  download.isPending &&
                  download.variables?.id === review.id &&
                  download.variables.side === side
                }
                onClick={() => download.mutate({ id: review.id, side })}
              >
                {t('downloadSource', { side: side + 1 })}
              </Button>
            ))}
            {review.undoneAt === null && (
              <Button
                onClick={() => {
                  undo.reset();
                  setConfirm(review);
                }}
              >
                {t('undo')}
              </Button>
            )}
          </Space>
        </Card>
      ))}
      {history.hasNextPage && (
        <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          {t('loadMore')}
        </Button>
      )}
      <Modal
        open={confirm !== null}
        title={t('undo')}
        okText={t('undo')}
        cancelText={t('cancel')}
        confirmLoading={undo.isPending}
        cancelButtonProps={{ disabled: undo.isPending }}
        closable={!undo.isPending}
        mask={{ closable: !undo.isPending }}
        keyboard={!undo.isPending}
        onCancel={() => setConfirm(null)}
        onOk={() => {
          if (confirm !== null) undo.mutate(confirm.id);
        }}
      >
        <Typography.Paragraph>{t('undoConfirm')}</Typography.Paragraph>
        {undo.isError && <Alert type="error" showIcon title={describeError(undo.error)} />}
      </Modal>
    </Space>
  );
}
