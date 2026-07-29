import type { ReactNode } from 'react';

// Root layout (docs/10 §10.2). Providers (AntdRegistry, ConfigProvider, next-intl, QueryClient) are
// added in M2.7; this bootstrap keeps it minimal so a page renders on /.
export const metadata = {
  title: 'Legere',
  description: 'Self-hosted document management system.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
