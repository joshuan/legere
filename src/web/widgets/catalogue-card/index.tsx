'use client';

import { Card, Typography } from 'antd';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { CatalogueIcon, CatalogueIconTarget } from '../../../shared/contracts/catalogue-icons';
import { CatalogueIconView } from '../../entities/catalogue-icon';
import { useIsAdmin } from '../../entities/user';
import { EditCatalogueIcon } from '../../features/edit-catalogue-icon';

export function CatalogueCard({
  target,
  item,
  href,
}: {
  target: CatalogueIconTarget;
  item: {
    id: string;
    name: string;
    note: string | null;
    icon: CatalogueIcon | null;
    documentCount: number;
    lastDocumentAt: string | null;
    subjectCount?: number;
  };
  href: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const admin = useIsAdmin();
  return (
    <article className="legere-catalogue-card">
      <Link href={href} className="legere-catalogue-link" aria-label={item.name}>
        <Card
          hoverable
          styles={{ body: { padding: 12 } }}
          cover={
            <div className="legere-catalogue-cover">
              <CatalogueIconView icon={item.icon} target={target} id={item.id} />
            </div>
          }
        >
          <Typography.Paragraph
            className="legere-catalogue-name"
            ellipsis={{ rows: 2 }}
            title={item.name}
          >
            {item.name}
          </Typography.Paragraph>
          <Typography.Paragraph
            type="secondary"
            className="legere-catalogue-note"
            ellipsis={{ rows: 2 }}
            title={item.note ?? ''}
          >
            {item.note ?? '\u00a0'}
          </Typography.Paragraph>
          <div className="legere-catalogue-count">
            {t('browse.documentCount', { count: item.documentCount })}
          </div>
          {item.subjectCount !== undefined && (
            <Typography.Text type="secondary">
              {t('catalogueCards.objectCount', { count: item.subjectCount })}
            </Typography.Text>
          )}
          {item.lastDocumentAt !== null && (
            <Typography.Text type="secondary" className="legere-catalogue-date">
              {t('catalogueCards.lastDocument', {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: 'medium',
                  timeZone: 'UTC',
                }).format(new Date(`${item.lastDocumentAt}T00:00:00Z`)),
              })}
            </Typography.Text>
          )}
        </Card>
      </Link>
      {admin && (
        <EditCatalogueIcon target={target} id={item.id} name={item.name} icon={item.icon} />
      )}
    </article>
  );
}
