'use client';

import { DeleteOutlined, FileImageOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Empty, Space, Spin, Switch, Tag, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { documentFiles } from '../../entities/document';
import { scanSetApi, scanSetKeys } from '../../entities/scan-set';
import { useErrorMessage } from '../../shared/lib';
import { statusColor } from '../scan-sets';

// A queued merge finishes on its own; the builder follows it (docs/11 §11.8).
const LIVE_REFRESH_MS = 5000;

// /scan-sets/:id (docs/11 §11.8): order the pages, crop or not, merge.
export function ScanSetBuilderScreen({ id }: { id: string }) {
  const t = useTranslations();
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const scanSet = useQuery({
    queryKey: scanSetKeys.detail(id),
    queryFn: () => scanSetApi.get(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'QUEUED' || status === 'PROCESSING' ? LIVE_REFRESH_MS : false;
    },
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: scanSetKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: scanSetKeys.all });
  };

  const update = useMutation({
    mutationFn: (input: { name?: string; cropMode?: 'TRIM' | 'NONE'; items?: string[] }) =>
      scanSetApi.update(id, input),
    onSuccess: refresh,
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const merge = useMutation({
    mutationFn: () => scanSetApi.merge(id),
    onSuccess: () => {
      void message.success(t('scanSets.queued'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  if (scanSet.isPending) return <Spin />;
  if (scanSet.data === undefined) return <Empty description={t('errors.codes.NOT_FOUND')} />;

  const detail = scanSet.data;
  // Only a draft or a failed set may be changed (docs/03 §3.3.16); the UI reflects that rather than
  // letting the user find out from a 409.
  const editable = detail.status === 'DRAFT' || detail.status === 'FAILED';
  const order = detail.items.map((item) => item.documentId);

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    update.mutate({ items: next });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <Space direction="vertical" size={0}>
          <Typography.Title
            level={3}
            style={{ margin: 0 }}
            editable={
              editable
                ? {
                    onChange: (name) => {
                      if (name.trim() !== '' && name !== detail.name) update.mutate({ name });
                    },
                  }
                : false
            }
          >
            {detail.name}
          </Typography.Title>
          <Space>
            <Tag color={statusColor(detail.status)}>{detail.status}</Tag>
            <Typography.Text type="secondary">
              {t('scanSets.pageCount', { count: detail.itemCount })}
            </Typography.Text>
          </Space>
        </Space>

        <Space>
          <Space size="small">
            <Switch
              checked={detail.cropMode === 'TRIM'}
              disabled={!editable}
              aria-label={t('scanSets.trimMargins')}
              onChange={(on) => update.mutate({ cropMode: on ? 'TRIM' : 'NONE' })}
            />
            <Typography.Text>{t('scanSets.trimMargins')}</Typography.Text>
          </Space>
          <Button
            type="primary"
            disabled={!editable || detail.items.length === 0}
            loading={merge.isPending}
            onClick={() => merge.mutate()}
          >
            {t('scanSets.merge')}
          </Button>
        </Space>
      </Space>

      {detail.status === 'FAILED' && detail.error !== null && (
        <Alert
          type="error"
          showIcon
          message={t('scanSets.failed')}
          // The set stays editable underneath: fix the pages, merge again (docs/05 §5.6).
          description={detail.error}
        />
      )}

      {detail.status === 'DONE' && detail.resultDocumentId !== null && (
        <Alert
          type="success"
          showIcon
          message={t('scanSets.done')}
          description={
            <Link href={`/documents/${detail.resultDocumentId}`}>{t('scanSets.openResult')}</Link>
          }
        />
      )}

      <Card title={t('scanSets.pages')}>
        {detail.items.length === 0 ? (
          <Empty description={t('scanSets.noPages')} />
        ) : (
          <Space wrap size="middle" align="start">
            {detail.items.map((item, index) => (
              <Card
                key={item.documentId}
                size="small"
                style={{ width: 150 }}
                cover={
                  <div
                    style={{
                      height: 120,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: token.colorBgLayout,
                    }}
                  >
                    {item.hasPreview ? (
                      // 302s to a signed URL (docs/10 §10.8).
                      <img
                        src={documentFiles.thumb(item.documentId)}
                        alt=""
                        style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <FileImageOutlined
                        style={{ fontSize: 32, color: token.colorTextQuaternary }}
                        aria-hidden
                      />
                    )}
                  </div>
                }
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Text ellipsis style={{ width: '100%' }} title={item.title}>
                    {index + 1}. {item.title}
                  </Typography.Text>
                  {editable && (
                    <Space size={4}>
                      <Button
                        size="small"
                        icon={<LeftOutlined />}
                        aria-label={t('scanSets.movePageLeft', { position: index + 1 })}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      />
                      <Button
                        size="small"
                        icon={<RightOutlined />}
                        aria-label={t('scanSets.movePageRight', { position: index + 1 })}
                        disabled={index === detail.items.length - 1}
                        onClick={() => move(index, 1)}
                      />
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={t('scanSets.removePage', { position: index + 1 })}
                        disabled={detail.items.length === 1}
                        onClick={() =>
                          update.mutate({
                            items: order.filter((documentId) => documentId !== item.documentId),
                          })
                        }
                      />
                    </Space>
                  )}
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}
