import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { getLocale, getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AppProviders } from '../web/shared/providers';
import '../web/shared/styles/globals.css';

// The three faces of docs/11 §11.15. `next/font` self-hosts them in the bundle at build time: a
// self-hosted instance on a private network must never reach out to a font CDN to render a page.
const display = Fraunces({
  subsets: ['latin', 'latin-ext'],
  axes: ['SOFT', 'WONK', 'opsz'],
  variable: '--font-display',
  display: 'swap',
});

const sans = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

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
    <html lang={locale} className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <AppProviders locale={locale} messages={messages}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
