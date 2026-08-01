'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Col, Empty, Popconfirm, Row, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { ShareModal } from '../../features/collection-share';
import { useErrorMessage } from '../../shared/lib';
import { DocumentCard } from '../../widgets/document-card';

// /collections/:id (docs/11 §11.7). A viewer who is not the owner gets no edit affordances at all —
// the API would refuse them anyway, and offering them would be a lie.
export function CollectionDetailScreen({
  id,
  currentUserId,
}: {
  id: string;
  currentUserId: string;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [sharing, setSharing] = useState(false);

  const detail = useQuery({
    queryKey: collectionKeys.detail(id),
    queryFn: () => collectionApi.get(id),
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
  if (detail.data === undefined) return <Empty description={t('errors.codes.NOT_FOUND')} />;

  const { collection, items } = detail.data;
  const isOwner = collection.ownerId === currentUserId;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <Space direction="vertical" size={0}>
          <Typography.Title
            level={3}
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
      </Space>

      {items.items.length === 0 ? (
        <Empty description={t('collections.emptyItems')} />
      ) : (
        <Row gutter={[16, 16]}>
          {items.items.map((document) => (
            <Col key={document.id} xs={12} sm={8} md={6} lg={4}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
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
            </Col>
          ))}
        </Row>
      )}

      <ShareModal collectionId={id} open={sharing} onClose={() => setSharing(false)} />
    </Space>
  );
}
