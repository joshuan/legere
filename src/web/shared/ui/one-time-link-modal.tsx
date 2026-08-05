'use client';

import { Alert, Input, Modal, Typography } from 'antd';
import { useTranslations } from 'next-intl';

// Invite and reset URLs — and API tokens (docs/08 §8.2a) — are returned exactly once
// (docs/07 §7.4), so the modal says so plainly and makes the value easy to copy: there is no way to
// retrieve it again afterwards. `labels` exists because what is shown once is not always a link.
export function OneTimeLinkModal({
  open,
  title,
  url,
  expiresAt,
  labels,
  onClose,
}: {
  open: boolean;
  title: string;
  url: string | null;
  expiresAt: string | null;
  labels?: { warning: string; copy: string };
  onClose: () => void;
}) {
  const t = useTranslations();

  return (
    <Modal open={open} title={title} onCancel={onClose} onOk={onClose} footer={null}>
      <Alert type="warning" showIcon message={labels?.warning ?? t('admin.oneTimeLink.warning')} />
      <Typography.Paragraph style={{ marginTop: 16 }}>
        <Input.TextArea value={url ?? ''} readOnly autoSize aria-label={title} />
      </Typography.Paragraph>
      <Typography.Paragraph copyable={{ text: url ?? '' }} type="secondary">
        {labels?.copy ?? t('admin.oneTimeLink.copy')}
      </Typography.Paragraph>
      {expiresAt !== null && (
        <Typography.Text type="secondary">
          {t('admin.oneTimeLink.expires', { date: new Date(expiresAt).toLocaleString() })}
        </Typography.Text>
      )}
    </Modal>
  );
}
