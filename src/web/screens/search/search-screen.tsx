'use client';

import { useQuery } from '@tanstack/react-query';
import { Empty, Input, List, Radio, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { searchModeSchema, type SearchMode } from '../../../shared/contracts/search';
import { documentFiles } from '../../entities/document';
import { searchApi, searchKeys, type SearchInput } from '../../entities/search';
import { DocumentFiltersBar } from '../../features/document-filters';
import type { DocumentFilters } from '../../entities/document';

// /search?q= (docs/11 §11.6). The query, the mode and the filters all live in the URL, so a search
// is a link.
export function SearchScreen() {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const q = params.get('q') ?? '';
  const mode = searchModeSchema.safeParse(params.get('mode') ?? 'hybrid');
  const filters: DocumentFilters = useMemo(() => {
    const next: DocumentFilters = {};
    const libraryId = params.get('libraryId');
    if (libraryId !== null) next.libraryId = libraryId;
    const typeId = params.get('typeId');
    if (typeId !== null) next.typeId = typeId;
    return next;
  }, [params]);

  const [draft, setDraft] = useState(q);

  const navigate = (next: { q?: string; mode?: SearchMode; filters?: DocumentFilters }): void => {
    const query = new URLSearchParams();
    const text = next.q ?? q;
    if (text !== '') query.set('q', text);
    const nextMode = next.mode ?? (mode.success ? mode.data : 'hybrid');
    if (nextMode !== 'hybrid') query.set('mode', nextMode);
    for (const [key, value] of Object.entries(next.filters ?? filters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const search = query.toString();
    router.replace(search === '' ? pathname : `${pathname}?${search}`);
  };

  // Only the filters search itself supports (docs/07 §7.3); the shared bar offers a couple more,
  // which belong to the documents list.
  const input: SearchInput = {
    q,
    mode: mode.success ? mode.data : 'hybrid',
    libraryId: filters.libraryId,
    typeId: filters.typeId,
  };

  const results = useQuery({
    queryKey: searchKeys.query(input),
    queryFn: () => searchApi.search(input),
    enabled: q !== '',
  });

  const semanticAvailable = results.data?.semanticAvailable ?? true;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Input.Search
        allowClear
        size="large"
        value={draft}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        onChange={(event) => setDraft(event.target.value)}
        onSearch={(value) => navigate({ q: value.trim() })}
        enterButton
      />

      <Space wrap size="middle">
        <Radio.Group
          value={mode.success ? mode.data : 'hybrid'}
          onChange={(event) => navigate({ mode: searchModeSchema.parse(event.target.value) })}
        >
          <Radio.Button value="hybrid">{t('search.modes.hybrid')}</Radio.Button>
          <Radio.Button value="text">{t('search.modes.text')}</Radio.Button>
          <Tooltip title={semanticAvailable ? undefined : t('search.semanticUnavailable')}>
            {/* Disabled rather than hidden: the instance *could* have it, and the tooltip says why
                it does not (docs/11 §11.6). */}
            <Radio.Button value="semantic" disabled={!semanticAvailable}>
              {t('search.modes.semantic')}
            </Radio.Button>
          </Tooltip>
        </Radio.Group>

        <DocumentFiltersBar value={filters} onChange={(next) => navigate({ filters: next })} />
      </Space>

      {q === '' ? (
        <Empty description={t('search.start')} />
      ) : results.isPending ? (
        <Spin />
      ) : (results.data?.items.length ?? 0) === 0 ? (
        <Empty description={t('search.noResults')}>
          <Typography.Text type="secondary">{t('search.noResultsHint')}</Typography.Text>
        </Empty>
      ) : (
        <List
          dataSource={results.data?.items ?? []}
          renderItem={(hit) => (
            <List.Item key={hit.document.id}>
              <List.Item.Meta
                avatar={
                  hit.document.hasPreview ? (
                    // to a signed URL (docs/10 §10.8).
                    <img
                      src={documentFiles.thumb(hit.document.id)}
                      alt=""
                      style={{ width: 48, height: 64, objectFit: 'cover' }}
                    />
                  ) : undefined
                }
                title={
                  <Space>
                    <Link href={`/documents/${hit.document.id}`}>{hit.document.title}</Link>
                    {hit.document.documentType !== null && (
                      <Tag color="blue">{hit.document.documentType.name}</Tag>
                    )}
                  </Space>
                }
                description={<Snippet snippet={hit.snippet} />}
              />
            </List.Item>
          )}
        />
      )}
    </Space>
  );
}

// The snippet is the one string the API marks up, and only with <mark> around the matched words
// (docs/07 §7.3). It is split on those tags rather than injected as HTML, so nothing else the
// document contains can be rendered as markup.
function Snippet({ snippet }: { snippet: string | null }) {
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
