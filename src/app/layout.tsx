import { getLocale, getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { TIME_ZONE } from '../i18n/request';
import { AppProviders } from '../web/shared/providers';
import '@joshuan/design-system/styles.css';
import '../web/shared/styles/globals.css';

// Root layout (docs/10 §10.2): html/body plus the client platform. The user's own theme preference
// is applied by the (app) layout once /api/me is known; here SYSTEM is the sensible default, since
// public pages have no user yet.
export const metadata = {
  title: 'Legere',
  description: 'Self-hosted document management system.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

  return (
    <html lang={locale}>
      <body>
        <AppProviders locale={locale} messages={messages} timeZone={TIME_ZONE}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
