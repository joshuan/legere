'use client';

import { Button, Result } from 'antd';
import { useTranslations } from 'next-intl';

// Segment-level render error (docs/10 §10.7 level 1).
export default function SegmentError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations();

  return (
    <Result
      status="error"
      title={t('errors.title')}
      subTitle={t('errors.unexpected')}
      extra={
        <Button type="primary" onClick={reset}>
          {t('common.actions.retry')}
        </Button>
      }
    />
  );
}
