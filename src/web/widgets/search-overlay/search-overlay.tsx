'use client';

import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Divider, Empty, Input, Spin, Typography, theme, type InputRef } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DocumentListDto } from '../../../shared/contracts/documents';
import { SearchResultRow, searchApi, searchKeys, useRecentDocuments } from '../../entities/search';
import { useDebouncedValue } from '../../shared/lib';

// A word typed at speed costs one request, not six (docs/11 §11.1a).
const DEBOUNCE_MS = 250;

// A short list of the top results — the overlay answers "which document", the page ranks them all
// (docs/11 §11.1a, §11.6).
const OVERLAY_LIMIT = 8;

type Row = { document: DocumentListDto; snippet: string | null };

// What the overlay holds (docs/11 §11.1a). Mounted only while it is open, so every visit starts on
// an empty query rather than on what somebody looked for an hour ago.
export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const { token } = theme.useToken();
  const inputRef = useRef<InputRef>(null);

  const [query, setQuery] = useState('');
  // Which row the keyboard is on; -1 is none, and Enter then means "all of them".
  const [highlight, setHighlight] = useState(-1);

  const typed = query.trim();
  const debounced = useDebouncedValue(typed, DEBOUNCE_MS);
  const searching = typed !== '';

  // The same GET /api/search the page runs, in the same default hybrid mode (docs/07 §7.3): a
  // faster way to the one instrument, never a second search with its own opinion about what matches.
  const input = { q: debounced, mode: 'hybrid' as const, limit: OVERLAY_LIMIT };
  const results = useQuery({
    queryKey: searchKeys.query(input),
    queryFn: () => searchApi.search(input),
    enabled: debounced !== '',
  });

  // An empty query is not an empty overlay: it shows what the search page's empty state shows.
  const recent = useRecentDocuments(!searching);

  // The overlay's input is focused the moment it appears — it is the only reason to raise it. One
  // tick later, because the overlay is drawn through a portal whose container is attached after
  // this mounts, and focusing an element that is not in the document yet does nothing at all.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const rows: Row[] = searching
    ? (results.data?.items ?? []).map((hit) => ({ document: hit.document, snippet: hit.snippet }))
    : (recent.data?.items ?? [])
        .slice(0, OVERLAY_LIMIT)
        .map((item) => ({ document: item, snippet: null }));

  // Between the keystroke and the answer the list is neither the old results nor the recent
  // documents: it is waiting.
  const waiting = searching && (debounced !== typed || results.isPending);

  const openDocument = (id: string): void => {
    onClose();
    router.push(`/documents/${id}`);
  };

  // Enter with nothing highlighted, and the All results row, do the same thing: the page, carrying
  // what was typed (docs/11 §11.1a).
  const openAllResults = (): void => {
    if (typed === '') return;
    onClose();
    router.push(`/search?q=${encodeURIComponent(typed)}`);
  };

  // The whole path is the keyboard's (docs/11 §11.1a). It sits on the overlay rather than on the
  // input so a key pressed anywhere inside it is read the same way — Escape included, which the
  // dialog underneath answers only to a legacy `keyCode` nothing modern sends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current) => (rows.length === 0 ? -1 : (current + 1) % rows.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) =>
        rows.length === 0 ? -1 : (current <= 0 ? rows.length : current) - 1,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[highlight];
      if (row === undefined) openAllResults();
      else openDocument(row.document.id);
    }
  };

  const activeRow = rows[highlight];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onKeyDown={onKeyDown}>
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        prefix={<SearchOutlined />}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        role="combobox"
        aria-expanded
        aria-controls="legere-search-overlay-results"
        {...(activeRow === undefined
          ? {}
          : { 'aria-activedescendant': optionId(activeRow.document.id) })}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          // A new query is a new list; keeping the old index would highlight a row nobody chose.
          setHighlight(-1);
        }}
      />

      <Divider style={{ margin: 0 }} />

      {!searching && rows.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('search.recent')}
        </Typography.Text>
      )}

      <div
        id="legere-search-overlay-results"
        role="listbox"
        aria-label={t('search.resultsLabel')}
        style={{ maxHeight: '50vh', overflowY: 'auto' }}
      >
        {waiting ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={searching ? t('search.noResults') : t('search.start')}
          >
            {searching && (
              <Typography.Text type="secondary">{t('search.noResultsHint')}</Typography.Text>
            )}
          </Empty>
        ) : (
          rows.map((row, index) => (
            <div
              key={row.document.id}
              id={optionId(row.document.id)}
              role="option"
              aria-selected={index === highlight}
              onClick={() => openDocument(row.document.id)}
              // The pointer moves the same highlight the arrows move, so there is never a second one.
              onMouseEnter={() => setHighlight(index)}
              style={{
                padding: '8px 12px',
                borderRadius: token.borderRadius,
                cursor: 'pointer',
                background: index === highlight ? token.controlItemBgHover : undefined,
              }}
            >
              <SearchResultRow document={row.document} snippet={row.snippet} linked={false} />
            </div>
          ))
        )}
      </div>

      {searching && (
        <Button type="text" block onClick={openAllResults}>
          {t('search.allResults')}
        </Button>
      )}
    </div>
  );
}

const optionId = (documentId: string): string => `legere-search-option-${documentId}`;
