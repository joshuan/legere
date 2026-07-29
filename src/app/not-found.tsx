import { Button, Result } from 'antd';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

// 404 page (docs/10 §10.7). Also what the admin segment renders for a non-admin (docs/10 §10.2).
export default async function NotFound() {
  const t = await getTranslations();

  return (
    <Result
      status="404"
      title={t('errors.notFound.title')}
      subTitle={t('errors.notFound.description')}
      extra={
        <Link href="/">
          <Button type="primary">{t('errors.notFound.backHome')}</Button>
        </Link>
      }
    />
  );
}
