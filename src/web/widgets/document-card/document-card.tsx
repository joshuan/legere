'use client';

import { FileTextOutlined, LoadingOutlined } from '@ant-design/icons';
import { Card, Space, Tag, Tooltip, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { documentFiles } from '../../entities/document';

// One card in the grid (docs/11 §11.3). The thumbnail is a plain <img>: the API 302s to a signed
// URL and the browser follows it, so no JavaScript is involved in fetching it (docs/10 §10.8).
export function DocumentCard({ document }: { document: DocumentListDto }) {
  const t = useTranslations();
  // A thumbnail can be missing even when the step says DONE — an artifact swept from the bucket, a
  // document deleted mid-scroll. The icon is the honest fallback rather than a broken image.
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = document.hasPreview && !thumbFailed;

  return (
    <Link href={`/documents/${document.id}`} style={{ display: 'block', height: '100%' }}>
      <Card
        hoverable
        styles={{ body: { padding: 12 } }}
        cover={
          <div
            style={{
              height: 160,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fafafa',
              overflow: 'hidden',
            }}
          >
            {showThumb ? (
              // The URL is an API route that 302s to a signed URL; next/image would proxy and
              // cache private content through a shared optimizer (docs/10 §10.8).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={documentFiles.thumb(document.id)}
                alt=""
                loading="lazy"
                onError={() => setThumbFailed(true)}
                style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
              />
            ) : (
              <FileTextOutlined style={{ fontSize: 40, color: '#bfbfbf' }} aria-hidden />
            )}
          </div>
        }
      >
        <Tooltip title={document.title}>
          <Typography.Paragraph
            ellipsis={{ rows: 2 }}
            style={{ marginBottom: 8, minHeight: 44 }}
            title={document.title}
          >
            {document.title}
          </Typography.Paragraph>
        </Tooltip>

        <Space size={[4, 4]} wrap>
          {document.ext !== '' && <Tag>{document.ext.toUpperCase()}</Tag>}
          {document.category !== null && <Tag color="blue">{document.category.name}</Tag>}
          {document.processing && (
            <Tag icon={<LoadingOutlined />} color="processing">
              {t('documents.badges.processing')}
            </Tag>
          )}
          {document.availability === 'UNAVAILABLE' && (
            <Tag color="default">{t('documents.badges.unavailable')}</Tag>
          )}
        </Space>
      </Card>
    </Link>
  );
}
