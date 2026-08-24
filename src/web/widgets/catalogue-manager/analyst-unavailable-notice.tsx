'use client';

import { Alert } from 'antd';
import { useTranslations } from 'next-intl';

// What the three catalogue screens draw where the suggestions banner would be, when the analyst was
// asked and could not answer (docs/11 §11.12a, docs/05 §5.6c). An empty banner area used to mean
// both "nothing to merge here" and "the provider answered 500", which is how the feature stayed
// dead on a live instance without anybody noticing.
//
// The banner's own shape and place, in the warning tone rather than the informational one — and
// nothing else: no group, no button, and none of the provider's error text, which an admin cannot
// act on and the operator who can reads in the log instead (docs/06 §6.7).
export function AnalystUnavailableNotice({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  return (
    <Alert
      type="warning"
      showIcon
      closable
      style={{ marginBottom: 16 }}
      onClose={onClose}
      message={t('admin.catalogues.suggestions.unavailable')}
    />
  );
}
