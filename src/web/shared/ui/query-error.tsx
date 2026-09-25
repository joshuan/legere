'use client';

import { Alert, Button } from 'antd';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '../lib';

// Read failures must stay distinct from an empty collection and offer a way to recover.
export function QueryError({ error, retry }: { error: unknown; retry: () => unknown }) {
  const t = useTranslations();
  const describeError = useErrorMessage();
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      message={describeError(error)}
      action={
        <Button
          onClick={() => {
            void retry();
          }}
        >
          {t('common.actions.retry')}
        </Button>
      }
    />
  );
}
