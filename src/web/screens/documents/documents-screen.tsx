'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Checkbox, Col, Empty, Row, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { availabilitySchema } from '../../../shared/contracts/documents';
import { fileOriginSchema } from '../../../shared/contracts/enums';
import type { GroupingSuggestion } from '../../../shared/contracts/files';
import {
  documentApi,
  documentFiles,
  documentKeys,
  type DocumentFilters,
} from '../../entities/document';
import { DocumentFiltersBar } from '../../features/document-filters';
import { DocumentCard } from '../../widgets/document-card';
import {
  UploadButton,
  UploadDropZone,
  UploadingCard,
  useDocumentUpload,
} from '../../features/document-upload';
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

  // Multi-select exists for one reason: making one document out of several (docs/11 §11.3). It stays
  // off until asked for, so an ordinary click still opens a document.
  const [selecting, setSelecting] = useState(false);
  const upload = useDocumentUpload();
  // Selection order is page order — the order they were ticked in is the order their files end up
  // in, so this is a list rather than a set (docs/11 §11.3).
  const [selected, setSelected] = useState<string[]>([]);

  const combine = useMutation({
    mutationFn: (documentIds: string[]) => {
      const [survivor, ...rest] = documentIds;
      if (survivor === undefined) throw new Error('nothing selected');
      return documentApi.combine(survivor, { documentIds: rest });
    },
    onSuccess: (result) => {
      void message.success(t('documents.selection.combined'), 2);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      setSelecting(false);
      setSelected([]);
      // The result is what the person asked for, and it is rebuilding — so the viewer is where they
      // should be watching it (docs/11 §11.3).
      router.push(`/documents/${result.id}`);
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
      <Row align="middle" justify="space-between" gutter={[16, 16]}>
        <Col>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {t('documents.title')}
          </Typography.Title>
        </Col>
        <Col>
          {/* Anyone may add a document of their own; the library is the admin's business
              (docs/11 §11.3). */}
          <UploadButton onFiles={upload.send} />
        </Col>
      </Row>

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
              {t('documents.selection.count', { count: selected.length })}
            </Typography.Text>
            <Button
              type="primary"
              // One document combined with nothing is the document it already was.
              disabled={selected.length < 2}
              loading={combine.isPending}
              onClick={() => combine.mutate(selected)}
            >
              {t('documents.selection.combine')}
            </Button>
          </Space>
        )}
      </Space>

      {/* Above the grid, and only while nothing is being looked for in particular: a proposal about
          the whole shelf makes no sense over a filtered view of it (docs/11 §11.3). */}
      {Object.keys(filters).length === 0 && (
        <GroupingSuggestions
          onCombine={(documentIds) => combine.mutate(documentIds)}
          combining={combine.isPending}
        />
      )}

      {documents.isPending ? (
        <Spin />
      ) : items.length === 0 && upload.items.length === 0 ? (
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
        <UploadDropZone onFiles={upload.send}>
          <Row gutter={[16, 16]}>
            {/* Ahead of everything: a file chosen a second ago is the newest thing here, and it is
                also the thing the person is waiting on (docs/11 §11.3). */}
            {upload.items.map((queued) => (
              <Col key={queued.key} xs={12} sm={8} md={6} lg={4} xl={4} xxl={4}>
                <UploadingCard upload={queued} onDismiss={() => upload.dismiss(queued.key)} />
              </Col>
            ))}
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
        </UploadDropZone>
      )}
    </Space>
  );
}

// Only values the contract knows survive the trip; a hand-edited URL cannot smuggle a filter in.
function parseFilters(params: URLSearchParams): DocumentFilters {
  const filters: DocumentFilters = {};

  const libraryId = params.get('libraryId');
  if (libraryId !== null) filters.libraryId = libraryId;

  const typeId = params.get('typeId');
  if (typeId !== null) filters.typeId = typeId;

  const availability = availabilitySchema.safeParse(params.get('availability'));
  if (availability.success) filters.availability = availability.data;

  const origin = fileOriginSchema.safeParse(params.get('origin'));
  if (origin.success) filters.origin = origin.data;

  const processing = params.get('processing');
  if (processing === 'true') filters.processing = true;
  if (processing === 'false') filters.processing = false;

  return filters;
}

// Dismissing a suggestion lasts the session and nothing longer: the server proposes, and it never
// remembers being refused (docs/11 §11.3). A module-level set is exactly that lifetime — it survives
// walking into a document and back, and dies with the tab.
const DISMISSED_SUGGESTIONS = new Set<string>();

// At most three, because this is a hint above the shelf and not a second screen (docs/11 §11.3).
const MAX_SUGGESTIONS = 3;

// How many of a group's pages are shown as thumbnails before it stops being a glance.
const SUGGESTION_THUMBS = 6;

// "These look like one document." Single-file image documents that arrived one after another in the
// same folder, offered as one document rather than found later by hand (docs/05 §5.6a).
function GroupingSuggestions({
  onCombine,
  combining,
}: {
  onCombine: (documentIds: string[]) => void;
  combining: boolean;
}) {
  const t = useTranslations();
  const [dismissed, setDismissed] = useState<string[]>(() => [...DISMISSED_SUGGESTIONS]);

  const suggestions = useQuery({
    queryKey: documentKeys.groupingSuggestions,
    queryFn: documentApi.groupingSuggestions,
  });

  const visible = (suggestions.data?.items ?? [])
    .filter((suggestion) => !dismissed.includes(keyOf(suggestion)))
    .slice(0, MAX_SUGGESTIONS);
  if (visible.length === 0) return null;

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text type="secondary">{t('documents.suggestions.title')}</Typography.Text>
      <Row gutter={[16, 16]}>
        {visible.map((suggestion) => (
          <Col key={keyOf(suggestion)} xs={24} md={12} xl={8}>
            <Card size="small">
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space size={4} wrap>
                  {suggestion.documentIds.slice(0, SUGGESTION_THUMBS).map((documentId) => (
                    // An API route that 302s to a signed URL (docs/10 §10.8).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={documentId}
                      src={documentFiles.thumb(documentId)}
                      alt=""
                      loading="lazy"
                      style={{ height: 56, width: 42, objectFit: 'cover' }}
                    />
                  ))}
                </Space>
                <Typography.Text>
                  {t(
                    suggestion.reason === 'NAME_SEQUENCE'
                      ? 'documents.suggestions.nameSequence'
                      : 'documents.suggestions.sameSitting',
                    { count: suggestion.documentIds.length, folder: folderOf(suggestion) },
                  )}
                </Typography.Text>
                <Space>
                  <Button
                    type="primary"
                    size="small"
                    loading={combining}
                    onClick={() => onCombine(suggestion.documentIds)}
                  >
                    {t('documents.suggestions.combine')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      const key = keyOf(suggestion);
                      DISMISSED_SUGGESTIONS.add(key);
                      setDismissed((current) => [...current, key]);
                    }}
                  >
                    {t('documents.suggestions.dismiss')}
                  </Button>
                </Space>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </Space>
  );
}

// A suggestion is computed and never stored, so it has no id of its own: the documents it names are
// what identifies it.
function keyOf(suggestion: GroupingSuggestion): string {
  return suggestion.documentIds.join(':');
}

// The library and the folder inside it, as a person would say where something is.
function folderOf(suggestion: GroupingSuggestion): string {
  return suggestion.folder === ''
    ? suggestion.libraryName
    : `${suggestion.libraryName}/${suggestion.folder}`;
}

// `--legere-index` drives the animation delay in CSS. React types style as CSSProperties, which has
// no room for custom properties, so it is built as a Record and handed over as one.
function staggerStyle(index: number): CSSProperties {
  const custom: Record<string, string> = { '--legere-index': String(index % STAGGER_LIMIT) };
  return custom;
}
