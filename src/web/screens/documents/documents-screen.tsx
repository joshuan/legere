'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Checkbox, Col, Empty, Row, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { availabilitySchema, type DocumentListDto } from '../../../shared/contracts/documents';
import { documentSourceSchema } from '../../../shared/contracts/enums';
import { documentApi, documentKeys, type DocumentFilters } from '../../entities/document';
import { scanSetApi, scanSetKeys } from '../../entities/scan-set';
import { DocumentFiltersBar } from '../../features/document-filters';
import { DocumentCard } from '../../widgets/document-card';
import { useErrorMessage } from '../../shared/lib';

// While anything on screen is still being processed the list refreshes, so a document stops saying
// "Processing" without the user reloading (docs/10 §10.5).
const LIVE_REFRESH_MS = 5000;

// How many cards take part in the entrance (docs/11 §11.15). Roughly a screenful at the widest
// breakpoint: past that the animation would be a delay, not a flourish.
const STAGGER_LIMIT = 18;

// /documents (docs/11 §11.3): the home screen.
export function DocumentsScreen({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

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

  // Multi-select exists for one reason: turning a stack of photographed pages into a scan set
  // (docs/11 §11.8). It stays off until asked for, so an ordinary click still opens a document.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // Mapped over the selection, not filtered from the grid: the order pages were clicked in is the
  // page order of the set (docs/11 §11.8).
  const selectedDocuments = selected.flatMap((id) => {
    const found = items.find((item) => item.id === id);
    return found === undefined ? [] : [found];
  });
  const images = selectedDocuments.filter(isImage);
  const skipped = selectedDocuments.length - images.length;

  const createScanSet = useMutation({
    mutationFn: () =>
      scanSetApi.create({
        name: t('documents.selection.defaultName'),
        cropMode: 'TRIM',
        // Selection order is page order; the builder is where it gets rearranged.
        items: images.map((item) => item.id),
      }),
    onSuccess: (created) => {
      void message.success(t('documents.selection.created'), 2);
      void queryClient.invalidateQueries({ queryKey: scanSetKeys.all });
      setSelecting(false);
      setSelected([]);
      router.push(`/scan-sets/${created.id}`);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

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

      <Space wrap size="middle">
        <DocumentFiltersBar value={filters} onChange={setFilters} />
        <Button
          onClick={() => {
            setSelecting((on) => !on);
            setSelected([]);
          }}
        >
          {selecting ? t('documents.selection.cancel') : t('documents.selection.start')}
        </Button>
        {selecting && (
          <Space>
            <Typography.Text type="secondary">
              {t('documents.selection.count', { count: images.length })}
            </Typography.Text>
            {skipped > 0 && (
              // Mixed selections are allowed; the non-images are simply not pages (docs/11 §11.8).
              <Typography.Text type="warning">
                {t('documents.selection.skipped', { count: skipped })}
              </Typography.Text>
            )}
            <Button
              type="primary"
              disabled={images.length === 0}
              loading={createScanSet.isPending}
              onClick={() => createScanSet.mutate()}
            >
              {t('documents.selection.create')}
            </Button>
          </Space>
        )}
      </Space>

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
            {items.map((document, index) => (
              <Col
                key={document.id}
                xs={12}
                sm={8}
                md={6}
                lg={4}
                xl={4}
                xxl={4}
                // The one orchestrated moment of the screen (docs/11 §11.15): the grid deals itself
                // out 40 ms at a time. Only the first screenful is staggered — a card arriving on
                // page seven should appear, not perform.
                className={index < STAGGER_LIMIT ? 'legere-enter' : undefined}
                style={staggerStyle(index)}
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {selecting && (
                    <Checkbox
                      checked={selected.includes(document.id)}
                      disabled={!isImage(document)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, document.id]
                            : current.filter((id) => id !== document.id),
                        )
                      }
                    >
                      {document.title}
                    </Checkbox>
                  )}
                  <DocumentCard document={document} />
                </Space>
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

// Only images can be pages of a scan set (docs/03 §3.3.17).
function isImage(document: DocumentListDto): boolean {
  return document.mimeType.startsWith('image/');
}

// `--legere-index` drives the animation delay in CSS. React types style as CSSProperties, which has
// no room for custom properties, so it is built as a Record and handed over as one.
function staggerStyle(index: number): CSSProperties {
  const custom: Record<string, string> = { '--legere-index': String(index % STAGGER_LIMIT) };
  return custom;
}
