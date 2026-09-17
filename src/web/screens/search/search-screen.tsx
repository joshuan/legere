'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Empty,
  Input,
  List,
  Radio,
  Select,
  Space,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  searchModeSchema,
  searchSortSchema,
  type SearchMode,
  type SearchSort,
} from '../../../shared/contracts/search';
import {
  SearchResultRow,
  searchApi,
  searchKeys,
  useRecentDocuments,
  type SearchInput,
} from '../../entities/search';
import { DocumentFiltersBar } from '../../features/document-filters';
import type { DocumentFilters } from '../../entities/document';
import { useErrorMessage } from '../../shared/lib';

// The submitted search lives in the URL. Back/Forward restores both the form and the results.
export function SearchScreen() {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const mode = searchModeSchema.catch('hybrid').parse(params.get('mode') ?? 'hybrid');
  const sort = searchSortSchema.catch('relevance').parse(params.get('sort') ?? 'relevance');
  const filters: DocumentFilters = useMemo(() => {
    const next: DocumentFilters = {};
    const libraryId = params.get('libraryId');
    if (libraryId !== null) next.libraryId = libraryId;
    const typeId = params.get('typeId');
    if (typeId !== null) next.typeId = typeId;
    return next;
  }, [params]);
  const navigate = (next: {
    q?: string;
    mode?: SearchMode;
    sort?: SearchSort;
    filters?: DocumentFilters;
  }): void => {
    const query = new URLSearchParams();
    const text = next.q ?? q;
    if (text !== '') query.set('q', text);
    const nextMode = next.mode ?? mode;
    if (nextMode !== 'hybrid') query.set('mode', nextMode);
    const nextSort = next.sort ?? sort;
    if (nextSort !== 'relevance') query.set('sort', nextSort);
    for (const [key, value] of Object.entries(next.filters ?? filters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const search = query.toString();
    const href = search === '' ? pathname : `${pathname}?${search}`;
    if (next.q !== undefined && text !== q) router.push(href);
    else router.replace(href);
  };

  const input: SearchInput = {
    q,
    mode,
    sort,
    limit: 50,
    libraryId: filters.libraryId,
    typeId: filters.typeId,
  };
  // An empty query is cheap and tells the page whether semantic search is configured.
  const results = useQuery({
    queryKey: searchKeys.query(input),
    queryFn: () => searchApi.search(input),
  });
  const recent = useRecentDocuments(q === '');
  const semanticAvailable = results.data?.semanticAvailable ?? true;
  const error = q === '' ? recent.error : results.error;

  return (
    <section aria-label={t('search.resultsLabel')} style={{ width: '100%', maxWidth: 1200 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <SearchQueryInput key={q} query={q} onSearch={(value) => navigate({ q: value.trim() })} />
        <Typography.Text type="secondary">{t('search.reach')}</Typography.Text>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space wrap size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
            <Radio.Group
              value={mode}
              onChange={(event) => navigate({ mode: searchModeSchema.parse(event.target.value) })}
            >
              {searchModeSchema.options.map((value) => (
                <Tooltip
                  key={value}
                  title={
                    value === 'semantic' && !semanticAvailable
                      ? t('search.semanticUnavailable')
                      : t(`search.modeHints.${value}`)
                  }
                >
                  <Radio.Button value={value} disabled={value === 'semantic' && !semanticAvailable}>
                    {t(`search.modes.${value}`)}
                  </Radio.Button>
                </Tooltip>
              ))}
            </Radio.Group>
            <Select
              aria-label={t('search.sortLabel')}
              style={{ minWidth: 260, maxWidth: '100%' }}
              value={sort}
              onChange={(value) => navigate({ sort: searchSortSchema.parse(value) })}
              options={searchSortSchema.options.map((value) => ({
                value,
                label: t(`search.sorts.${value}`),
              }))}
            />
          </Space>
          <Typography.Text type="secondary">{t(`search.modeHints.${mode}`)}</Typography.Text>
          <DocumentFiltersBar
            searchOnly
            value={filters}
            onChange={(next) => navigate({ filters: next })}
          />
        </Space>
        {!semanticAvailable && (
          <Alert type="info" showIcon message={t('search.semanticUnavailable')} />
        )}
        {semanticAvailable && results.data?.semanticFallback && (
          <Alert type="warning" showIcon message={t('search.semanticFallback')} />
        )}
        {mode !== 'text' && semanticAvailable && sort !== 'relevance' && (
          <Typography.Text type="secondary">{t('search.semanticSortHint')}</Typography.Text>
        )}
        {error !== null ? (
          <Alert
            type="error"
            showIcon
            message={describeError(error)}
            action={
              <Button
                onClick={() => {
                  void (q === '' ? recent.refetch() : results.refetch());
                }}
              >
                {t('search.retry')}
              </Button>
            }
          />
        ) : q === '' ? (
          recent.isPending ? (
            <Spin />
          ) : (recent.data?.items.length ?? 0) === 0 ? (
            <Empty description={t('search.start')} />
          ) : (
            <>
              <Typography.Text type="secondary">{t('search.recent')}</Typography.Text>
              <List
                dataSource={recent.data?.items ?? []}
                renderItem={(item) => (
                  <List.Item key={item.id}>
                    <SearchResultRow document={item} />
                  </List.Item>
                )}
              />
            </>
          )
        ) : results.isPending ? (
          <Spin />
        ) : (results.data?.items.length ?? 0) === 0 ? (
          <Empty description={t('search.noResults')}>
            <Typography.Text type="secondary">{t('search.noResultsHint')}</Typography.Text>
          </Empty>
        ) : (
          <>
            <Typography.Text type="secondary">
              {t('search.shown', { count: results.data?.items.length ?? 0 })}
            </Typography.Text>
            <List
              dataSource={results.data?.items ?? []}
              renderItem={(hit) => (
                <List.Item key={hit.document.id}>
                  <SearchResultRow
                    document={hit.document}
                    snippet={hit.snippet}
                    matchedIn={hit.matchedIn}
                  />
                </List.Item>
              )}
            />
          </>
        )}
      </Space>
    </section>
  );
}

function SearchQueryInput({
  query,
  onSearch,
}: {
  query: string;
  onSearch: (value: string) => void;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState(query);
  return (
    <Input.Search
      id="document-search-input"
      autoFocus
      allowClear
      size="large"
      value={draft}
      placeholder={t('search.placeholder')}
      aria-label={t('search.placeholder')}
      onChange={(event) => setDraft(event.target.value)}
      onSearch={onSearch}
      enterButton
    />
  );
}
