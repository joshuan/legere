'use client';

import { ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import ruRU from 'antd/locale/ru_RU';
import { useLocale } from 'next-intl';
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import type { Theme } from '../../../shared/contracts/enums';
import { legereTheme } from '../theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

// The OS colour scheme is an external store, so it is read through useSyncExternalStore: the theme
// keeps following the system setting live rather than sampling it once (docs/10 §10.4).
function subscribeToColorScheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

// The server cannot know the client's colour scheme; light is the neutral first paint.
const serverSnapshot = (): boolean => false;

export function ThemeProvider({
  children,
  preference = 'SYSTEM',
}: {
  children: ReactNode;
  preference?: Theme;
}) {
  const locale = useLocale();
  const getSnapshot = useCallback(
    () => (preference === 'SYSTEM' ? systemPrefersDark() : preference === 'DARK'),
    [preference],
  );
  const dark = useSyncExternalStore(subscribeToColorScheme, getSnapshot, serverSnapshot);

  return (
    <ConfigProvider locale={locale === 'ru' ? ruRU : enUS} theme={legereTheme(dark)}>
      {children}
    </ConfigProvider>
  );
}
