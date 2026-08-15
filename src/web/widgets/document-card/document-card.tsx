'use client';

import { FileTextOutlined, LoadingOutlined } from '@ant-design/icons';
import { Card, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import {
  fieldSchemaFor,
  moneyValueSchema,
  type DocumentFieldSpec,
} from '../../../shared/contracts/document-fields';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { documentFiles } from '../../entities/document';
import { DEFAULT_DOCUMENT_CARD_FIELDS, type DocumentCardField } from './card-fields';

// One card in the grid (docs/11 §11.3). The thumbnail is a plain <img>: the API 302s to a signed
// URL and the browser follows it, so no JavaScript is involved in fetching it (docs/10 §10.8).
//
// `fields` is which of the document's own facts to draw. It defaults to the arrangement the card
// always had, so the four screens that render it without asking — browse, facets, a collection, the
// search results — keep what they have rather than inheriting the home screen's choice.
// While the grid is picking documents the card is the target, not the tick in its corner: aiming at
// a checkbox is not what choosing feels like (docs/11 §11.3). `selection` being present *is* the
// mode — the card stops being a link for as long as it is there, so one gesture never means two
// things on one screen.
export function DocumentCard({
  document,
  fields = DEFAULT_DOCUMENT_CARD_FIELDS,
  selection,
}: {
  document: DocumentListDto;
  fields?: readonly DocumentCardField[];
  selection?: { picked: boolean; onToggle: () => void };
}) {
  const t = useTranslations();
  const locale = useLocale();
  // A thumbnail can be missing even when the step says DONE — an artifact swept from the bucket, a
  // document deleted mid-scroll. The icon is the honest fallback rather than a broken image.
  const [thumbFailed, setThumbFailed] = useState(false);
  const { token } = theme.useToken();
  const showThumb = document.hasPreview && !thumbFailed;
  const shows = (field: DocumentCardField): boolean => fields.includes(field);
  // As a person would say where something is, and only the halves that are known.
  const place = [document.city, document.country].filter((part) => part !== null).join(', ');
  // What was read off the paper, formatted for the reader (docs/11 §11.3): the summary values of
  // the document's field schema, in schema order. Empty where the type carries no schema.
  const extractedParts = shows('fields') ? summaryParts(document, locale) : [];

  const card = (
    <Card
      hoverable
      styles={{ body: { padding: 12 } }}
      // Picked from across the grid, not by reading a corner. The outline is drawn on the card
      // itself so that a glance over a full screen answers "which ones did I take?".
      style={
        selection?.picked === true
          ? { outline: `2px solid ${token.colorPrimary}`, outlineOffset: -2 }
          : {}
      }
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
      {/* The extracted fields, one line, middle dots between values — what was read off the paper
            (docs/03 §3.3.10a). Drawn like the names below: a line of text, never a stack of tags. */}
      {extractedParts.length > 0 && <NameLine names={extractedParts} separator=" · " />}
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
  );

  if (selection !== undefined) {
    // A button, not a div with a handler: the keyboard reaches it the way it reaches the link this
    // card is the rest of the time, and a hit area only a mouse can use is half a fix.
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={selection.picked}
        aria-label={document.title}
        onClick={selection.onToggle}
        style={{
          display: 'block',
          height: '100%',
          width: '100%',
          padding: 0,
          border: 'none',
          background: 'none',
          textAlign: 'inherit',
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        {card}
      </button>
    );
  }

  return (
    <Link href={`/documents/${document.id}`} style={{ display: 'block', height: '100%' }}>
      {card}
    </Link>
  );
}

// One line of names, cut off rather than wrapped, with the whole list on hover.
function NameLine({ names, separator = ', ' }: { names: string[]; separator?: string }) {
  const joined = names.join(separator);
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

// The summary values in schema order, each formatted for the reader — the client's half of
// `extractedSummary` (docs/07 §7.3): the server sends values as stored, the registry the client
// ships says what they are.
function summaryParts(document: DocumentListDto, locale: string): string[] {
  const schema = fieldSchemaFor(document.documentType?.slug ?? null);
  const summary = document.extractedSummary;
  if (schema === null || summary === null) return [];

  const parts: string[] = [];
  for (const spec of schema.fields) {
    if (spec.summary !== true) continue;
    const value = summary[spec.key];
    if (value === undefined || value === null) continue;
    const text = formatSummaryValue(spec, value, locale);
    if (text !== null) parts.push(text);
  }
  return parts;
}

function formatSummaryValue(spec: DocumentFieldSpec, value: unknown, locale: string): string | null {
  switch (spec.kind) {
    case 'string':
      return typeof value === 'string' && value !== '' ? value : null;
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : null;
    case 'date': {
      if (typeof value !== 'string') return null;
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return null;
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        parsed,
      );
    }
    case 'money': {
      const parsed = moneyValueSchema.safeParse(value);
      if (!parsed.success) return null;
      try {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: parsed.data.currency,
        }).format(parsed.data.amount);
      } catch {
        // A currency Intl does not know is still a currency the receipt named.
        return `${new Intl.NumberFormat(locale).format(parsed.data.amount)} ${parsed.data.currency}`;
      }
    }
    // A table is a pane's to draw (docs/11 §11.5), never a card line's.
    case 'table':
      return null;
  }
}
