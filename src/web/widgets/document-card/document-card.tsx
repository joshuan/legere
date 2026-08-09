'use client';

import { FileTextOutlined, LoadingOutlined } from '@ant-design/icons';
import { Card, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { documentFiles } from '../../entities/document';
import { DEFAULT_DOCUMENT_CARD_FIELDS, type DocumentCardField } from './card-fields';

// One card in the grid (docs/11 §11.3). The thumbnail is a plain <img>: the API 302s to a signed
// URL and the browser follows it, so no JavaScript is involved in fetching it (docs/10 §10.8).
//
// `fields` is which of the document's own facts to draw. It defaults to the arrangement the card
// always had, so the four screens that render it without asking — browse, facets, a collection, the
// search results — keep what they have rather than inheriting the home screen's choice.
export function DocumentCard({
  document,
  fields = DEFAULT_DOCUMENT_CARD_FIELDS,
}: {
  document: DocumentListDto;
  fields?: readonly DocumentCardField[];
}) {
  const t = useTranslations();
  // A thumbnail can be missing even when the step says DONE — an artifact swept from the bucket, a
  // document deleted mid-scroll. The icon is the honest fallback rather than a broken image.
  const [thumbFailed, setThumbFailed] = useState(false);
  const { token } = theme.useToken();
  const showThumb = document.hasPreview && !thumbFailed;
  const shows = (field: DocumentCardField): boolean => fields.includes(field);
  // As a person would say where something is, and only the halves that are known.
  const place = [document.city, document.country].filter((part) => part !== null).join(', ');

  return (
    <Link href={`/documents/${document.id}`} style={{ display: 'block', height: '100%' }}>
      <Card
        hoverable
        styles={{ body: { padding: 12 } }}
        cover={
          <div
            style={{
              height: 168,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // The shelf behind the page: distinct from both the page and the card, so the card
              // keeps a visible top edge (docs/11 §11.15).
              background: 'var(--legere-well)',
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
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
                style={{
                  maxHeight: '100%',
                  maxWidth: '100%',
                  objectFit: 'contain',
                  // A page has an edge; a floating bitmap does not.
                  boxShadow: token.boxShadowTertiary,
                }}
              />
            ) : (
              <FileTextOutlined
                style={{ fontSize: 38, color: token.colorTextQuaternary }}
                aria-hidden
              />
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
          {shows('ext') && document.primaryExt !== '' && (
            <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em' }}>
              {document.primaryExt.toUpperCase()}
            </Tag>
          )}
          {/* Only when it is made of more than one: "1 file" is a fact about every document, and a
              badge that is always there says nothing (docs/11 §11.3). */}
          {document.fileCount > 1 && (
            <Tag>{t('documents.badges.files', { count: document.fileCount })}</Tag>
          )}
          {shows('type') && document.documentType !== null && (
            <Tag color="blue">{document.documentType.name}</Tag>
          )}
          {/* The date written on the paper, not the day it was filed (docs/03 §3.3.10) — absent
              from the badge row entirely while nobody has read one. */}
          {shows('date') && document.documentDate !== null && <Tag>{document.documentDate}</Tag>}
          {shows('place') && place !== '' && <Tag>{place}</Tag>}
          {shows('languages') &&
            document.languages.map((language) => (
              <Tag
                key={language}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em' }}
              >
                {language.toUpperCase()}
              </Tag>
            ))}
          {document.processing && (
            <Tag icon={<LoadingOutlined />} color="processing">
              {t('documents.badges.processing')}
            </Tag>
          )}
          {/* Some of it can be read and some of it cannot — which is a different thing from a
              document nobody can open, and it is worth saying which (docs/03 §3.3.10). */}
          {document.availability === 'PARTIAL' && (
            <Tag color="warning">{t('documents.badges.partial')}</Tag>
          )}
          {document.availability === 'UNAVAILABLE' && (
            <Tag color="default">{t('documents.badges.unavailable')}</Tag>
          )}
        </Space>
        {/* Names, not badges: who and what the document is about is read as a line of text, and one
            line of it — a document naming eight people must not make a card eight rows taller
            (docs/11 §11.3). */}
        {shows('people') && document.people.length > 0 && (
          <NameLine names={document.people.map((person) => person.name)} />
        )}
        {shows('subjects') && document.subjects.length > 0 && (
          <NameLine names={document.subjects.map((subject) => subject.name)} />
        )}
      </Card>
    </Link>
  );
}

// One line of names, cut off rather than wrapped, with the whole list on hover.
function NameLine({ names }: { names: string[] }) {
  const joined = names.join(', ');
  return (
    <Typography.Paragraph
      type="secondary"
      ellipsis={{ rows: 1 }}
      title={joined}
      style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}
    >
      {joined}
    </Typography.Paragraph>
  );
}
