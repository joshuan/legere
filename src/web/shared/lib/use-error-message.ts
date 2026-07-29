'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { isApiError, messageKeyFor } from '../api';

// Turns any thrown value into a localized, user-facing string (docs/10 §10.3, §10.7). The server's
// own `message` is never shown — the UI localizes by `code`.
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations();

  return useCallback(
    (error: unknown): string =>
      isApiError(error) ? t(messageKeyFor(error.code)) : t('errors.unexpected'),
    [t],
  );
}
