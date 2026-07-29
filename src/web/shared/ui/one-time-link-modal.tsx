'use client';

import { Alert, Input, Modal, Typography } from 'antd';
import { useTranslations } from 'next-intl';

// Invite and reset URLs are returned exactly once (docs/07 §7.4), so the modal says so plainly and
// makes the value easy to copy — there is no way to retrieve it again afterwards.
export function OneTimeLinkModal({
  open,
  title,
  url,
  expiresAt,
  onClose,
}: {
  open: boolean;
  title: string;
  url: string | null;
  expiresAt: string | null;
  onClose: () => void;
}) {
  const t = useTranslations();

  return (
    <Modal open={open} title={title} onCancel={onClose} onOk={onClose} footer={null}>
      <Alert type="warning" showIcon message={t('admin.oneTimeLink.warning')} />
      <Typography.Paragraph style={{ marginTop: 16 }}>
        <Input.TextArea value={url ?? ''} readOnly autoSize aria-label={title} />
      </Typography.Paragraph>
      <Typography.Paragraph copyable={{ text: url ?? '' }} type="secondary">
        {t('admin.oneTimeLink.copy')}
      </Typography.Paragraph>
      {expiresAt !== null && (
        <Typography.Text type="secondary">
          {t('admin.oneTimeLink.expires', { date: new Date(expiresAt).toLocaleString() })}
        </Typography.Text>
      )}
    </Modal>
  );
}
