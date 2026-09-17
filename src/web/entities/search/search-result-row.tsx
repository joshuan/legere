'use client';

import { List, Space, Tag, Typography } from 'antd';
import { useFormatter, useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import type { SearchMatchField } from '../../../shared/contracts/search';
import { documentFiles } from '../document';

// A search result with the dates that explain chronological ordering.
export function SearchResultRow({
  document: item,
  snippet = null,
  matchedIn,
}: {
  document: DocumentListDto;
  // Absent where there is nothing matched to quote — the recent documents an empty query answers
  // with.
  snippet?: string | null;
  // Why this row is here; recent documents have no match to explain.
  matchedIn?: readonly SearchMatchField[];
}) {
  const t = useTranslations();
  const format = useFormatter();
  const date = (value: string): string =>
    format.dateTime(new Date(value), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  return (
    <List.Item.Meta
      avatar={
        item.hasPreview ? (
          // Kept unoptimized so the authenticated browser request reaches our API route, which
          // redirects it to a short-lived signed URL (docs/10 §10.8).
          <Image
            src={documentFiles.thumb(item.id)}
            alt=""
            width={48}
            height={64}
            unoptimized
            style={{ width: 48, height: 64, objectFit: 'cover' }}
          />
        ) : undefined
      }
      title={
        <Space size={8} wrap>
          <Link href={`/documents/${item.id}`}>{item.title}</Link>
          {item.documentType !== null && <Tag color="blue">{item.documentType.name}</Tag>}
        </Space>
      }
      description={
        <>
          <Space wrap size="middle" style={{ marginBottom: 4, fontSize: 12 }}>
            <Typography.Text type="secondary">
              {item.documentDate === null
                ? t('search.noDocumentDate')
                : t('search.documentDate', { date: date(item.documentDate) })}
            </Typography.Text>
            <Typography.Text type="secondary">
              {t('search.addedDate', { date: date(item.createdAt) })}
            </Typography.Text>
          </Space>
          <SearchSnippet snippet={snippet} />
          {matchedIn !== undefined && matchedIn.length > 0 && <MatchedIn fields={matchedIn} />}
        </>
      }
    />
  );
}

// What the engine matched, in the words a reader uses for those parts (docs/11 §11.6). Quiet on
// purpose: it is the footnote to a result, not the result — but it is the difference between "why is
// this here" and "because the scan is called that".
function MatchedIn({ fields }: { fields: readonly SearchMatchField[] }) {
  const t = useTranslations();

  return (
    <Space size={4} wrap>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('search.why')}
      </Typography.Text>
      {fields.map((field) => (
        <Tag key={field} bordered={false}>
          {t(`search.matchedIn.${field}`)}
        </Tag>
      ))}
    </Space>
  );
}

// The snippet is the one string the API marks up, and only with <mark> around the matched words
// (docs/07 §7.3). It is split on those tags rather than injected as HTML, so nothing else the
// document contains can be rendered as markup.
function SearchSnippet({ snippet }: { snippet: string | null }) {
  if (snippet === null || snippet === '') return null;

  // Odd positions are what stood between the tags, i.e. the matched words. The index is part of the
  // key on purpose: the same word can legitimately appear twice in one snippet.
  const parts = snippet.split(/<mark>|<\/mark>/).map((text, index) => ({
    text,
    matched: index % 2 === 1,
    key: `${index}:${text}`,
  }));

  return (
    <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
      {parts.map((part) =>
        part.matched ? (
          <mark key={part.key}>{part.text}</mark>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </Typography.Paragraph>
  );
}
