'use client';

import {
  CheckCircleFilled,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Button, Flex, Popconfirm, Progress, Tag, Tooltip, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import {
  isSettled,
  useUploadQueue,
  type UploadQueueItem,
  type UploadStatus,
} from '../../features/upload-queue';

// How long a clean run stays on the page after the last file lands. Long enough to read the last
// line of it, short enough that nobody has to dismiss it (docs/11 §11.3).
const AUTO_HIDE_MS = 5000;

// What the instance is uploading, as a column of the page (docs/11 §11.3). Not an overlay: the rows
// are the feedback for every file, they outlive the screen they were started from, and a stack of
// toasts over a grid says forty times what one list says once. Present only while there is something
// to say — the content simply reflows around it.
export function UploadPanel() {
  const t = useTranslations();
  const { token } = theme.useToken();
  const { items, busy, retry, retryFailed, clearAll } = useUploadQueue();

  const list = useRef<HTMLDivElement>(null);
  const activeKey = items.find((item) => item.status === 'uploading')?.key ?? null;

  const total = items.length;
  const settled = items.filter(isSettled).length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const duplicates = items.filter((item) => item.status === 'duplicate').length;
  // Weighted by bytes, not by files: a run of one 200 MB scan and nine small ones is not 10% done
  // when the first small one lands.
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  const sentBytes = items.reduce(
    (sum, item) => sum + (isSettled(item) ? item.size : item.loadedBytes),
    0,
  );
  const percent = totalBytes === 0 ? 0 : Math.round((sentBytes * 100) / totalBytes);
  const finished = total > 0 && settled === total;
  // Nothing left to look at: everything arrived, and no row is asking a question.
  const quiet = failed === 0 && duplicates === 0;

  // The file being sent stays in view while the list grows past the panel.
  useEffect(() => {
    if (activeKey === null) return;
    const row = list.current?.querySelector(`[data-upload-key="${activeKey}"]`);
    // jsdom has no scrollIntoView, and a panel that throws while trying to scroll is worse than one
    // that does not scroll.
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeKey]);

  // A run that went through without a word takes itself off. Anything a person might want to act on
  // — a failure, a duplicate that names another document — stays until it is closed. The timer is
  // laid again from scratch whenever the queue changes, so files arriving meanwhile push it back.
  useEffect(() => {
    if (!finished || !quiet) return undefined;
    const timer = setTimeout(clearAll, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [clearAll, finished, quiet, total]);

  if (total === 0) return null;

  const closeButton = (
    <Button
      type="text"
      size="small"
      aria-label={t('documents.upload.panel.close')}
      icon={<CloseOutlined />}
      {...(busy ? {} : { onClick: clearAll })}
    />
  );

  return (
    <section
      className="legere-upload-panel"
      aria-label={t('documents.upload.panel.label')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
      }}
    >
      {/* Outside the scrolling list rather than inside it: what is going on is the one thing that
          must not scroll away from the rows it counts. */}
      <div
        aria-live="polite"
        style={{
          padding: `${token.paddingSM}px ${token.padding}px`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex align="center" gap={token.marginXXS}>
          <Typography.Text strong ellipsis style={{ flex: '1 1 auto', minWidth: 0 }}>
            {finished
              ? t('documents.upload.panel.finished', { count: total })
              : t('documents.upload.panel.progress', { done: settled, total })}
          </Typography.Text>
          {failed > 0 && (
            <Button size="small" type="link" onClick={retryFailed} style={{ paddingInline: 0 }}>
              {t('documents.upload.panel.retryFailed')}
            </Button>
          )}
          {busy ? (
            <Popconfirm
              title={t('documents.upload.panel.closeConfirm')}
              okText={t('documents.upload.panel.closeConfirmOk')}
              cancelText={t('documents.upload.panel.closeConfirmCancel')}
              okButtonProps={{ danger: true }}
              onConfirm={clearAll}
            >
              {closeButton}
            </Popconfirm>
          ) : (
            closeButton
          )}
        </Flex>
        <Progress
          percent={percent}
          showInfo={false}
          size="small"
          status={failed > 0 ? 'exception' : 'normal'}
          style={{ marginBottom: 0, lineHeight: 1 }}
        />
      </div>

      <div
        ref={list}
        style={{
          overflowY: 'auto',
          flex: '1 1 auto',
          minHeight: 0,
          padding: `${token.paddingXS}px ${token.padding}px`,
        }}
      >
        {items.map((item) => (
          <UploadRow key={item.key} item={item} onRetry={() => retry(item.key)} />
        ))}
      </div>
    </section>
  );
}

// One file, in the position it was added in and never moved from: the status changes in place, so a
// glance down the column reads as the order the files were chosen in.
function UploadRow({ item, onRetry }: { item: UploadQueueItem; onRetry: () => void }) {
  const t = useTranslations();
  const { token } = theme.useToken();
  const percent = item.size === 0 ? 0 : Math.round((item.loadedBytes * 100) / item.size);

  return (
    <Flex
      align="center"
      gap={token.marginXS}
      data-upload-key={item.key}
      style={{ paddingBlock: token.paddingXXS, minHeight: 26 }}
    >
      {/* Why it failed is on the status itself: the row stays a row, and the sentence is one hover
          or one focus away rather than squeezing the file name out of the column. */}
      {item.status === 'failed' && item.error !== undefined ? (
        <Tooltip title={item.error}>
          <span style={{ display: 'inline-flex' }} tabIndex={0}>
            <StatusIcon status={item.status} />
          </span>
        </Tooltip>
      ) : (
        <StatusIcon status={item.status} />
      )}
      <Typography.Text
        ellipsis
        title={item.fileName}
        style={{ flex: '1 1 auto', minWidth: 0, fontSize: token.fontSizeSM }}
      >
        {item.fileName}
      </Typography.Text>

      {item.status === 'waiting' && (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t('documents.upload.panel.queued')}
        </Typography.Text>
      )}

      {item.status === 'uploading' && (
        <Flex align="center" gap={token.marginXXS} style={{ flex: '0 0 auto' }}>
          <Progress
            percent={percent}
            showInfo={false}
            size="small"
            style={{ width: 56, marginBottom: 0, lineHeight: 1 }}
          />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {t('documents.upload.panel.percent', { percent })}
          </Typography.Text>
        </Flex>
      )}

      {/* The bytes were already here, and this says where they are rather than that something went
          wrong (ADR-009). */}
      {item.status === 'duplicate' && item.resultDocumentId !== undefined && (
        <Link href={`/documents/${item.resultDocumentId}`}>
          <Tag style={{ marginInlineEnd: 0, cursor: 'pointer' }}>
            {t('documents.upload.panel.duplicate')}
          </Tag>
        </Link>
      )}

      {item.status === 'failed' && (
        <Button
          type="text"
          size="small"
          aria-label={t('documents.upload.panel.retry')}
          icon={<ReloadOutlined />}
          onClick={onRetry}
          style={{ flex: '0 0 auto' }}
        />
      )}
    </Flex>
  );
}

// The status as one glyph, named for anyone who cannot see it.
function StatusIcon({ status }: { status: UploadStatus }) {
  const t = useTranslations();
  const { token } = theme.useToken();
  const shape = { fontSize: token.fontSize, flex: '0 0 auto' };

  if (status === 'waiting') {
    return (
      <ClockCircleOutlined
        aria-label={t('documents.upload.panel.queued')}
        style={{ ...shape, color: token.colorTextSecondary }}
      />
    );
  }
  if (status === 'uploading') {
    return (
      <LoadingOutlined
        aria-label={t('documents.upload.panel.uploading')}
        style={{ ...shape, color: token.colorPrimary }}
      />
    );
  }
  if (status === 'done') {
    return (
      <CheckCircleFilled
        aria-label={t('documents.upload.panel.uploaded')}
        style={{ ...shape, color: token.colorSuccess }}
      />
    );
  }
  if (status === 'duplicate') {
    return (
      <CheckCircleOutlined
        aria-label={t('documents.upload.panel.duplicate')}
        style={{ ...shape, color: token.colorTextSecondary }}
      />
    );
  }
  return (
    <CloseCircleFilled
      aria-label={t('documents.upload.panel.failed')}
      style={{ ...shape, color: token.colorError }}
    />
  );
}
