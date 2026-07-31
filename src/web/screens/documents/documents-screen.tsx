'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Col, Empty, Row, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { availabilitySchema } from '../../../shared/contracts/documents';
import { documentSourceSchema } from '../../../shared/contracts/enums';
import { documentApi, documentKeys, type DocumentFilters } from '../../entities/document';
import { DocumentFiltersBar } from '../../features/document-filters';
import { DocumentCard } from '../../widgets/document-card';

// While anything on screen is still being processed the list refreshes, so a document stops saying
// "Processing" without the user reloading (docs/10 §10.5).
const LIVE_REFRESH_MS = 5000;

// /documents (docs/11 §11.3): the home screen.
export function DocumentsScreen({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The URL is the single source of truth for the filters, so a filtered view can be linked,
  // bookmarked and reloaded (docs/11 §11.3).
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const setFilters = useCallback(
    (next: DocumentFilters) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const query = params.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`);
    },
    [pathname, router],
  );

  const documents = useInfiniteQuery({
    queryKey: documentKeys.list(filters),
    // The first page has no cursor; every later one carries the previous page's nextCursor, and an
    // empty string stands for "from the beginning" so the parameter can stay a plain string.
    queryFn: ({ pageParam }) => documentApi.list(filters, pageParam === '' ? undefined : pageParam),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) =>
      (query.state.data?.pages ?? []).some((page) => page.items.some((item) => item.processing))
        ? LIVE_REFRESH_MS
        : false,
  });

  const items = useMemo(
    () => (documents.data?.pages ?? []).flatMap((page) => page.items),
    [documents.data],
  );

  // Infinite scroll: a sentinel below the grid asks for the next page as it comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (target === null || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && documents.hasNextPage) {
        void documents.fetchNextPage();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [documents]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('documents.title')}
      </Typography.Title>

      <DocumentFiltersBar value={filters} onChange={setFilters} />

      {documents.isPending ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty
          description={
            Object.keys(filters).length > 0
              ? t('documents.empty.filtered')
              : t('documents.empty.instance')
          }
        >
          {/* No dark-pattern empty state: whoever can fix it is told how (docs/11 §11.14). */}
          {Object.keys(filters).length === 0 && isAdmin && (
            <Link href="/admin/libraries">
              <Button type="primary">{t('documents.empty.addLibrary')}</Button>
            </Link>
          )}
        </Empty>
      ) : (
        <>
          <Row gutter={[16, 16]}>
            {items.map((document) => (
              <Col key={document.id} xs={12} sm={8} md={6} lg={4} xl={4} xxl={4}>
                <DocumentCard document={document} />
              </Col>
            ))}
          </Row>
          <div ref={sentinel} style={{ height: 1 }} />
          {documents.isFetchingNextPage && <Spin />}
        </>
      )}
    </Space>
  );
}

// Only values the contract knows survive the trip; a hand-edited URL cannot smuggle a filter in.
function parseFilters(params: URLSearchParams): DocumentFilters {
  const filters: DocumentFilters = {};

  const libraryId = params.get('libraryId');
  if (libraryId !== null) filters.libraryId = libraryId;

  const categoryId = params.get('categoryId');
  if (categoryId !== null) filters.categoryId = categoryId;

  const availability = availabilitySchema.safeParse(params.get('availability'));
  if (availability.success) filters.availability = availability.data;

  const source = documentSourceSchema.safeParse(params.get('source'));
  if (source.success) filters.source = source.data;

  const processing = params.get('processing');
  if (processing === 'true') filters.processing = true;
  if (processing === 'false') filters.processing = false;

  return filters;
}
