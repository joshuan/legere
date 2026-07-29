'use client';

import { AntdRegistry } from '@ant-design/nextjs-registry';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import type { ReactNode } from 'react';
import type { Theme } from '../../../shared/contracts/enums';
import { QueryProvider } from './query-provider';
import { ThemeProvider } from './theme-provider';

// The client platform every screen sits on (docs/10 §10.4–10.5). AntdRegistry is outermost so antd's
// styles are extracted during SSR; next-intl wraps the theme provider because the latter reads the
// active locale to pick antd's own locale bundle.
export function AppProviders({
  children,
  locale,
  messages,
  theme,
}: {
  children: ReactNode;
  locale: string;
  messages: AbstractIntlMessages;
  theme?: Theme;
}) {
  return (
    <AntdRegistry>
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ThemeProvider {...(theme === undefined ? {} : { preference: theme })}>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </NextIntlClientProvider>
    </AntdRegistry>
  );
}
