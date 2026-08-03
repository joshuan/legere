'use client';

import { AntdRegistry } from '@ant-design/nextjs-registry';
import { App as AntdApp } from 'antd';
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
  timeZone,
}: {
  children: ReactNode;
  locale: string;
  messages: AbstractIntlMessages;
  theme?: Theme;
  timeZone: string;
}) {
  return (
    <AntdRegistry>
      <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
        <ThemeProvider {...(theme === undefined ? {} : { preference: theme })}>
          <AntdApp>
            <QueryProvider>{children}</QueryProvider>
          </AntdApp>
        </ThemeProvider>
      </NextIntlClientProvider>
    </AntdRegistry>
  );
}
