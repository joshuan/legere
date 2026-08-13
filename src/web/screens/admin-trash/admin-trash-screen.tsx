'use client';

import { FileImageOutlined, FileTextOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Modal,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import type { TrashItemDto } from '../../../shared/contracts/trash';
import { trashApi, trashKeys } from '../../entities/trash';
import { formatBytes, useErrorMessage } from '../../shared/lib';

// /admin/trash (docs/11 §11.13b): every file that has left a document and has not been destroyed
// yet (docs/05 §5.7a), newest first. An admin's screen, because everything on it either destroys
// bytes or makes a document.
export function AdminTrashScreen() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  // Emptying the whole trash is a modal rather than a popconfirm: it names figures, and a sentence
  // about how much is about to go for good does not belong in a bubble (docs/11 §11.14).
  const [emptying, setEmptying] = useState(false);

  const trash = useInfiniteQuery({
    queryKey: trashKeys.list,
    queryFn: ({ pageParam }) => trashApi.list(pageParam === '' ? undefined : pageParam),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = useMemo(
    () => (trash.data?.pages ?? []).flatMap((page) => page.items),
    [trash.data],
  );

  // 🔒 The whole trash, not this page: "what is this costing me" is why the screen is opened at all
  // (docs/11 §11.13b), so the figure comes from the answer rather than from the rows on screen.
  const total = trash.data?.pages[0]?.total ?? null;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trashKeys.list });
    // A restore makes a document and a delete unmakes bytes: the grid counts both.
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  }, [queryClient]);

  const onError = useCallback(
    (error: unknown) => {
      void message.error(describeError(error));
    },
    [describeError, message],
  );

  const restore = useMutation({
    mutationFn: (fileId: string) => trashApi.restore(fileId),
    onSuccess: (result) => {
      // The new document is the whole answer, so the toast is the way to it: it is not the document
      // the file came from, and nobody knows where to look for it otherwise (docs/05 §5.7a).
      void message.success(
        <Link href={`/documents/${result.documentId}`}>{t('admin.trash.restored')}</Link>,
        3,
      );
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (fileId: string) => trashApi.remove(fileId),
    onSuccess: () => {
      void message.success(t('admin.trash.deleted'), 2);
      refresh();
    },
    onError,
  });

  const empty = useMutation({
    mutationFn: trashApi.empty,
    onSuccess: (result) => {
      setEmptying(false);
      void message.success(t('admin.trash.emptied', { count: result.deleted }), 2);
      refresh();
    },
    onError,
  });

  const columns = [
    {
      title: t('admin.trash.columns.file'),
      key: 'file',
      render: (_: unknown, item: TrashItemDto) => (
        <Space size={12} align="start">
          {/* The bytes of a trashed file are reachable through no route of docs/07, so the kind of
              thing it is stands where its thumbnail would (docs/11 §11.13b). */}
          <div
            style={{
              width: 40,
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--legere-well)',
            }}
          >
            {item.isImage ? (
              <FileImageOutlined
                style={{ fontSize: 18, color: token.colorTextQuaternary }}
                aria-hidden
              />
            ) : (
              <FileTextOutlined
                style={{ fontSize: 18, color: token.colorTextQuaternary }}
                aria-hidden
              />
            )}
          </div>
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Typography.Text>{item.name}</Typography.Text>
              {/* Bytes a volume lost: there is nothing left to restore, and the row says so rather
                  than letting somebody find out by pressing the button (docs/07 §7.3). */}
              {!item.available && <Tag>{t('viewer.files.missing')}</Tag>}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {`${item.mimeType} · ${formatBytes(item.sizeBytes)}`}
            </Typography.Text>
          </Space>
        </Space>
      ),
    },
    {
      title: t('admin.trash.columns.from'),
      key: 'from',
      render: (_: unknown, item: TrashItemDto) => (
        <Space direction="vertical" size={0}>
          {/* A record rather than a link: that document is usually gone by the time anybody reads
              this (docs/05 §5.7a). */}
          <Typography.Text>{item.trashedFrom ?? t('admin.trash.unknownDocument')}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t(`admin.trash.reasons.${item.reason}`)}
          </Typography.Text>
          {/* Local time, with the instant itself on hover (docs/11 §11.14). */}
          <Tooltip title={item.trashedAt}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {new Date(item.trashedAt).toLocaleString()}
            </Typography.Text>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: t('admin.trash.columns.goes'),
      key: 'goes',
      render: (_: unknown, item: TrashItemDto) =>
        // 🔒 No countdown for an original on a read-only volume: no sweep will ever delete it,
        // because Legere may not (ADR-007), and a date that will never arrive is a promise the
        // product cannot keep (docs/11 §11.13b).
        item.purgeAfter === null ? (
          <Space direction="vertical" size={2}>
            <Typography.Text>{t('admin.trash.goesOnVolume')}</Typography.Text>
            {item.refs.map((ref) => (
              <Typography.Text
                key={`${ref.libraryId}:${ref.path}`}
                type="secondary"
                style={{ fontSize: 12 }}
                code
              >
                {`${ref.libraryName}: ${ref.path}`}
              </Typography.Text>
            ))}
            {/* So nobody empties the trash expecting the disk to get smaller. */}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('admin.trash.volumeNote')}
            </Typography.Text>
          </Space>
        ) : (
          // A date, not "in 27 days": a date survives being read a week later.
          <Typography.Text>
            {t('admin.trash.goesOn', {
              date: new Date(item.purgeAfter).toLocaleDateString(),
            })}
          </Typography.Text>
        ),
    },
    {
      // No heading: the buttons say what they do, and a column called "Actions" over them is the
      // same word twice (docs/11 §11.15).
      title: '',
      key: 'actions',
      render: (_: unknown, item: TrashItemDto) => (
        <Space size="small">
          {item.available ? (
            <Popconfirm
              title={t('admin.trash.restoreTitle', { name: item.name })}
              // Said before it happens, not after: a restore does not put the page back where it
              // came from, and somebody expecting that would be surprised (docs/05 §5.7a).
              description={<div style={{ maxWidth: 320 }}>{t('admin.trash.restoreNote')}</div>}
              onConfirm={() => restore.mutate(item.id)}
            >
              <Button size="small" loading={restore.isPending && restore.variables === item.id}>
                {t('admin.trash.actions.restore')}
              </Button>
            </Popconfirm>
          ) : (
            <Tooltip title={t('viewer.files.missingReason')}>
              <Button size="small" disabled>
                {t('admin.trash.actions.restore')}
              </Button>
            </Tooltip>
          )}
          <Popconfirm
            title={t('admin.trash.deleteTitle', { name: item.name })}
            onConfirm={() => remove.mutate(item.id)}
          >
            <Button size="small" danger loading={remove.isPending && remove.variables === item.id}>
              {t('admin.trash.actions.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row align="middle" justify="space-between" gutter={[16, 8]}>
        <Col>
          <Typography.Title level={4} style={{ marginBottom: 4 }}>
            {t('admin.trash.title')}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('admin.trash.lead')}
          </Typography.Paragraph>
        </Col>
        {total !== null && (
          <Col>
            <Space size="middle" wrap>
              {/* What the trash costs, over the whole of it — the number that is the reason to open
                  this screen at all (docs/11 §11.13b). */}
              <Typography.Text strong style={{ fontSize: 16 }}>
                {t('admin.trash.summary', {
                  items: total.items,
                  size: formatBytes(total.bytes),
                })}
              </Typography.Text>
              {total.items > 0 && (
                <Button danger onClick={() => setEmptying(true)}>
                  {t('admin.trash.actions.emptyAll')}
                </Button>
              )}
            </Space>
          </Col>
        )}
      </Row>

      {trash.isError && (
        <Alert
          type="error"
          showIcon
          message={t('errors.title')}
          description={describeError(trash.error)}
        />
      )}

      <Card loading={trash.isPending}>
        {items.length === 0 && !trash.isPending ? (
          // Nothing here is not a problem, and an empty table says it far less plainly than a
          // sentence does (docs/11 §11.13b).
          <Empty description={t('admin.trash.empty')} />
        ) : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Table<TrashItemDto>
              rowKey="id"
              dataSource={items}
              columns={columns}
              pagination={false}
            />
            {trash.hasNextPage && (
              <Button
                type="link"
                loading={trash.isFetchingNextPage}
                onClick={() => void trash.fetchNextPage()}
                style={{ paddingLeft: 0 }}
              >
                {t('browse.more')}
              </Button>
            )}
          </Space>
        )}
      </Card>

      <Modal
        open={emptying}
        title={t('admin.trash.emptyTitle')}
        okText={t('admin.trash.actions.emptyAll')}
        okButtonProps={{ danger: true }}
        cancelText={t('common.actions.cancel')}
        confirmLoading={empty.isPending}
        onOk={() => empty.mutate()}
        onCancel={() => setEmptying(false)}
      >
        {/* The same figures the button stands beside, said again where they are about to be acted
            on — and what an original on a volume does and does not lose by it. */}
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          {t('admin.trash.emptyBody', {
            items: total?.items ?? 0,
            size: formatBytes(total?.bytes ?? '0'),
          })}
        </Typography.Paragraph>
      </Modal>
    </Space>
  );
}
