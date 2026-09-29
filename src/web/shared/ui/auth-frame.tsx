'use client';

import { Card } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function AuthFrame({ children, width = 440 }: { children: ReactNode; width?: number }) {
  const t = useTranslations();
  return (
    <main className="legere-auth-page" style={{ maxWidth: width }}>
      <Link href="/" className="legere-auth-brand">
        <span className="legere-brand-mark" aria-hidden>
          L
        </span>
        {t('common.appName')}
      </Link>
      <Card className="legere-auth-card">{children}</Card>
    </main>
  );
}
