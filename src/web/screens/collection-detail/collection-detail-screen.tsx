'use client';

import { useMutation, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Empty, Popconfirm, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { useCurrentUser } from '../../entities/user';
import { ShareModal } from '../../features/collection-share';
import { useErrorMessage } from '../../shared/lib';
import { QueryError } from '../../shared/ui';
import { DocumentCard } from '../../widgets/document-card';

// /collections/:id (docs/11 §11.7). A viewer who is not the owner gets no edit affordances at all —
// the API would refuse them anyway, and offering them would be a lie.
export function CollectionDetailScreen({ id }: { id: string }) {
  const t = useTranslations();
  // Who is reading this comes from the layout that already asked the API, rather than from a page
  // that had to ask again before this screen could be drawn (docs/10 §10.2).
  const { id: currentUserId } = useCurrentUser();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [sharing, setSharing] = useState(false);

  const detail = useInfiniteQuery({
    queryKey: collectionKeys.detail(id),
    queryFn: ({ pageParam }) => collectionApi.get(id, pageParam === '' ? undefined : pageParam),
    initialPageParam: '',
    getNextPageParam: (page) => page.items.nextCursor ?? undefined,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: collectionKeys.detail(id) });
  };

  const rename = useMutation({
    mutationFn: (name: string) => collectionApi.update(id, { name }),
    onSuccess: refresh,
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const removeItem = useMutation({
    mutationFn: (documentId: string) => collectionApi.removeItem(id, documentId),
    onSuccess: refresh,
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  if (detail.isPending) return <Spin />;
  if (detail.isError && detail.data === undefined)
    return <QueryError error={detail.error} retry={detail.refetch} />;
  const first = detail.data?.pages[0];
  if (first === undefined) return null;

  const { collection } = first;
  const items = detail.data?.pages.flatMap((page) => page.items.items) ?? [];
  const isOwner = collection.ownerId === currentUserId;

  return (
    <>
      {detail.isError && <QueryError error={detail.error} retry={detail.refetch} />}

      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <header className="legere-page-head" style={{ marginBottom: 0 }}>
          <Space orientation="vertical" size={0}>
            <Typography.Title
              level={1}
              style={{ margin: 0 }}
              editable={
                isOwner
                  ? {
                      onChange: (name) => {
                        if (name.trim() !== '' && name !== collection.name) rename.mutate(name);
                      },
                    }
                  : false
              }
            >
              {collection.name}
            </Typography.Title>
            {collection.description !== null && (
              <Typography.Text type="secondary">{collection.description}</Typography.Text>
            )}
            {!isOwner && (
              <Typography.Text type="secondary">
                {t('collections.ownedBy', { name: collection.ownerName })}
              </Typography.Text>
            )}
          </Space>

          {isOwner && (
            <Button onClick={() => setSharing(true)}>{t('collections.actions.share')}</Button>
          )}
        </header>

        {items.length === 0 ? (
          <Empty description={t('collections.emptyItems')} />
        ) : (
          <div className="legere-card-grid">
            {items.map((document) => (
              <div key={document.id}>
                <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                  <DocumentCard document={document} />
                  {isOwner && (
                    <Popconfirm
                      title={t('collections.confirmRemove', { title: document.title })}
                      okText={t('common.yes')}
                      cancelText={t('common.actions.cancel')}
                      onConfirm={() => removeItem.mutate(document.id)}
                    >
                      <Button size="small" block>
                        {t('collections.actions.remove')}
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              </div>
            ))}
          </div>
        )}

        {detail.hasNextPage && (
          <Button loading={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>
            {t('browse.more')}
          </Button>
        )}

        <ShareModal collectionId={id} open={sharing} onClose={() => setSharing(false)} />
      </Space>
    </>
  );
}
