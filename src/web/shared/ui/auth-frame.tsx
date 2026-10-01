'use client';

import { AppBrand } from '@joshuan/design-system/react';
import { BrandMark } from './brand-mark';
import { Card } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function AuthFrame({ children, width = 440 }: { children: ReactNode; width?: number }) {
  const t = useTranslations();
  return (
    <main className="legere-auth-page" style={{ maxWidth: width }}>
      <Link href="/" className="legere-auth-brand" aria-label={t('common.appName')}>
        <AppBrand name={t('common.appName')} mark={<BrandMark />} />
      </Link>
      <Card className="legere-auth-card">{children}</Card>
    </main>
  );
}
