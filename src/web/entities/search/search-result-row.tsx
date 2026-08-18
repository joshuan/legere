'use client';

import { List, Space, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import type { SearchMatchField } from '../../../shared/contracts/search';
import { documentFiles } from '../document';

// One result, drawn the same way wherever a result is read (docs/11 §11.6): thumbnail, title, the
// highlighted snippet, the document type. It lives in the entity rather than in the search screen
// because the overlay (docs/11 §11.1a) shows the same rows, and a result that looked different in
// the two places would read as two different searches.
export function SearchResultRow({
  document: item,
  snippet = null,
  linked = true,
  matchedIn,
}: {
  document: DocumentListDto;
  // Absent where there is nothing matched to quote — the recent documents an empty query answers
  // with.
  snippet?: string | null;
  // The overlay makes the whole row the target, so the title there is text rather than a second
  // link inside it.
  linked?: boolean;
  // Why this row is here (docs/11 §11.6). Given on the search screen and deliberately not in the
  // overlay, which is three rows and a way in; a row given none draws exactly as it always did.
  matchedIn?: readonly SearchMatchField[];
}) {
  return (
    <List.Item.Meta
      avatar={
        item.hasPreview ? (
          // to a signed URL (docs/10 §10.8).
          <img
            src={documentFiles.thumb(item.id)}
            alt=""
            style={{ width: 48, height: 64, objectFit: 'cover' }}
          />
        ) : undefined
      }
      title={
        <Space size={8} wrap>
          {linked ? (
            <Link href={`/documents/${item.id}`}>{item.title}</Link>
          ) : (
            <Typography.Text strong>{item.title}</Typography.Text>
          )}
          {item.documentType !== null && <Tag color="blue">{item.documentType.name}</Tag>}
        </Space>
      }
      description={
        <>
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
