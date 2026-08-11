'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Col, Empty, Row, Select, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DEFAULT_DOCUMENT_SORT,
  DOCUMENT_GROUP_BY,
  DOCUMENT_GROUP_FILTER,
  DOCUMENT_SORTS,
  availabilitySchema,
  documentGroupBySchema,
  documentSortSchema,
  documentStepSchema,
  listDocumentsQuerySchema,
  type DocumentGroup,
  type DocumentGroupBy,
  type DocumentSort,
} from '../../../shared/contracts/documents';
import { fileOriginSchema, stepStatusSchema } from '../../../shared/contracts/enums';
import type { GroupingSuggestion } from '../../../shared/contracts/files';
import {
  documentApi,
  documentFiles,
  documentKeys,
  type DocumentFilters,
} from '../../entities/document';
import { DocumentFiltersBar } from '../../features/document-filters';
import {
  DEFAULT_DOCUMENT_CARD_FIELDS,
  DOCUMENT_CARD_FIELDS,
  DocumentCard,
  formatDocumentCardFields,
  parseDocumentCardFields,
  type DocumentCardField,
} from '../../widgets/document-card';
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
  // bookmarked and reloaded (docs/11 §11.3). Everything else about the view lives there beside
  // them — the chosen order, which fields the cards show, and what the shelf is grouped by — for the
  // same reason and at the same accepted cost: it can be linked, and it does not follow the person
  // to another screen.
  const view = useMemo(() => parseView(searchParams), [searchParams]);
  const { filters, sort, fields, groupBy } = view;

  // The four are written together, because they share one query string: changing any of them must
  // not drop the others. A default leaves no trace, the way an unset filter does not.
  const setView = useCallback(
    (patch: Partial<DocumentsView>) => {
      const next = { ...view, ...patch };
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(next.filters)) {
        if (value !== undefined) params.set(key, String(value));
      }
      if (next.sort !== DEFAULT_DOCUMENT_SORT) params.set('sort', next.sort);
      const card = formatDocumentCardFields(next.fields);
      if (card !== null) params.set('card', card);
      if (next.groupBy !== null) params.set('groupBy', next.groupBy);
      const query = params.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`);
    },
    [pathname, router, view],
  );

  const setFilters = useCallback((next: DocumentFilters) => setView({ filters: next }), [setView]);

  const documents = useInfiniteQuery({
    queryKey: documentKeys.list(filters, sort),
    // The first page has no cursor; every later one carries the previous page's nextCursor, and an
    // empty string stands for "from the beginning" so the parameter can stay a plain string.
    //
    // 🔒 The order goes with every page, cursor included: the cursor names the order it was cut
    // from, and the API refuses one that disagrees rather than answering off the wrong column
    // (docs/07 §7.1). Changing the order changes the query key, so a page is never continued with a
    // cursor cut from the previous one.
    queryFn: ({ pageParam }) =>
      documentApi.list(filters, { sort, ...(pageParam === '' ? {} : { cursor: pageParam }) }),
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
    // Everything on the screen is inside the drop zone, the empty state included: a file is dropped
    // where the eye happens to be, and "not over the grid" is not a reason to refuse it
    // (docs/11 §11.3).
    <UploadDropZone onFiles={upload.send}>
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
          {/* Arranging the shelf, not narrowing it: the order sits beside the filters and outlives
              "Clear filters", which takes off what is in force rather than how it is laid out
              (docs/11 §11.3). */}
          <Select<DocumentSort>
            style={{ minWidth: 200 }}
            aria-label={t('documents.sort.label')}
            value={sort}
            onChange={(next) => setView({ sort: next })}
            options={DOCUMENT_SORTS.map((option) => ({
              value: option,
              label: t(`documents.sort.options.${option}`),
            }))}
          />
          {/* What the cards say about themselves. Not a filter either: it changes what is drawn on a
              card, not which cards there are, and it travels in the URL so a view stays one link
              (docs/11 §11.3). */}
          <Select<DocumentCardField[]>
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            style={{ minWidth: 220 }}
            aria-label={t('documents.card.label')}
            placeholder={t('documents.card.none')}
            value={[...fields]}
            onChange={(next) => setView({ fields: next })}
            options={DOCUMENT_CARD_FIELDS.map((option) => ({
              value: option,
              label: t(`documents.card.options.${option}`),
            }))}
          />
          {/* Real shelves with real counts, from the server: not headers drawn over whatever this
              page happened to hold (docs/11 §11.3). */}
          <Select<DocumentGroupBy | ''>
            style={{ minWidth: 180 }}
            aria-label={t('documents.groupBy.label')}
            value={groupBy ?? ''}
            onChange={(next) => setView({ groupBy: next === '' ? null : next })}
            options={[
              { value: '', label: t('documents.groupBy.none') },
              ...DOCUMENT_GROUP_BY.map((option) => ({
                value: option,
                label: t(`documents.groupBy.options.${option}`),
              })),
            ]}
          />
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

        {/* Above the grid, and only while nothing is being looked for in particular: a proposal
            about the whole shelf makes no sense over a filtered view of it (docs/11 §11.3). */}
        {Object.keys(filters).length === 0 && (
          <GroupingSuggestions
            onCombine={(documentIds) => combine.mutate(documentIds)}
            combining={combine.isPending}
          />
        )}

        {/* Grouped, the grid is drawn a section at a time, each one a heading and its own cards
            (docs/11 §11.3). Nothing is filtered by looking at it: leaving the grouping leaves the
            archive where it was. */}
        {groupBy !== null ? (
          <DocumentGroupSections
            by={groupBy}
            filters={filters}
            sort={sort}
            fields={fields}
            {...(selecting ? { selection: { selected, setSelected } } : {})}
          />
        ) : documents.isPending ? (
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
          <>
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
                  // The one orchestrated moment of the screen (docs/11 §11.15): the grid deals
                  // itself out 40 ms at a time. Only the first screenful is staggered — a card
                  // arriving on page seven should appear, not perform.
                  className={index < STAGGER_LIMIT ? 'legere-enter' : undefined}
                  style={staggerStyle(index)}
                >
                  <DocumentCard
                    document={document}
                    fields={fields}
                    {...(selecting
                      ? {
                          selection: {
                            picked: selected.includes(document.id),
                            onToggle: () =>
                              setSelected((current) =>
                                current.includes(document.id)
                                  ? current.filter((id) => id !== document.id)
                                  : [...current, document.id],
                              ),
                          },
                        }
                      : {})}
                  />
                </Col>
              ))}
            </Row>
            <div ref={sentinel} style={{ height: 1 }} />
            {documents.isFetchingNextPage && <Spin />}
          </>
        )}
      </Space>
    </UploadDropZone>
  );
}

// Everything the URL says about how this screen is being looked at (docs/11 §11.3): what is being
// narrowed, how it is arranged, what the cards say, and what it is grouped by. One object because
// they share one query string.
type DocumentsView = {
  filters: DocumentFilters;
  sort: DocumentSort;
  fields: readonly DocumentCardField[];
  groupBy: DocumentGroupBy | null;
};

function parseView(params: URLSearchParams): DocumentsView {
  return {
    filters: parseFilters(params),
    sort: parseSort(params),
    // Absent means the arrangement the card has always had; empty means "title only", which is a
    // choice somebody made and not the absence of one.
    fields: parseDocumentCardFields(params.get('card')) ?? DEFAULT_DOCUMENT_CARD_FIELDS,
    groupBy: parseGroupBy(params),
  };
}

// Only values the contract knows survive the trip; a hand-edited URL cannot smuggle a filter in.
//
// Every filter `GET /api/documents` takes is read here, not only the ones the bar draws a control
// for: a detail in the viewer is a link into this screen (docs/11 §11.5), and a link whose filter is
// dropped on arrival is a link that does not work. The ones with no control of their own come off
// through "Clear filters", which clears whatever is in force.
function parseFilters(params: URLSearchParams): DocumentFilters {
  const filters: DocumentFilters = {};

  const libraryId = params.get('libraryId');
  if (libraryId !== null) filters.libraryId = libraryId;

  const typeId = params.get('typeId');
  if (typeId !== null) filters.typeId = typeId;

  const personId = params.get('personId');
  if (personId !== null) filters.personId = personId;

  const subjectId = params.get('subjectId');
  if (subjectId !== null) filters.subjectId = subjectId;

  const subjectKindId = params.get('subjectKindId');
  if (subjectKindId !== null) filters.subjectKindId = subjectKindId;

  // Parsed by the contract's own schema rather than by hand: it is the thing that decides what a
  // year, a country code and a city may be, and a bad one is left off instead of sent on.
  const year = listDocumentsQuerySchema.shape.year.safeParse(params.get('year') ?? undefined);
  if (year.success && year.data !== undefined) filters.year = year.data;

  const country = listDocumentsQuerySchema.shape.country.safeParse(
    params.get('country') ?? undefined,
  );
  if (country.success && country.data !== undefined) filters.country = country.data;

  const city = listDocumentsQuerySchema.shape.city.safeParse(params.get('city') ?? undefined);
  if (city.success && city.data !== undefined) filters.city = city.data;

  const availability = availabilitySchema.safeParse(params.get('availability'));
  if (availability.success) filters.availability = availability.data;

  const origin = fileOriginSchema.safeParse(params.get('origin'));
  if (origin.success) filters.origin = origin.data;

  const processing = params.get('processing');
  if (processing === 'true') filters.processing = true;
  if (processing === 'false') filters.processing = false;

  // What a queue counter links to: a step and the status it sits in, always together. Half of the
  // pair is half a question, and the API answers a 422 to it — so half is never taken from the URL
  // either (docs/11 §11.13).
  const step = documentStepSchema.safeParse(params.get('step'));
  const stepStatus = stepStatusSchema.safeParse(params.get('stepStatus'));
  if (step.success && stepStatus.success) {
    filters.step = step.data;
    filters.stepStatus = stepStatus.data;
  }

  return filters;
}

// The chosen arrangement, read the same way and by the same rule: through the contract's own schema,
// so a hand-edited `?sort=whatever` falls back to the default instead of earning a 422 (docs/11
// §11.3). It is deliberately not a filter — "Clear filters" leaves it alone, the empty state does
// not count it, and the suggestion cards above the grid still appear on an unfiltered shelf however
// it is arranged.
function parseSort(params: URLSearchParams): DocumentSort {
  const parsed = documentSortSchema.safeParse(params.get('sort'));
  return parsed.success ? parsed.data : DEFAULT_DOCUMENT_SORT;
}

// And the grouping, by the same rule: a dimension the contract does not offer is no grouping at all
// rather than a request the API would refuse (docs/11 §11.3).
function parseGroupBy(params: URLSearchParams): DocumentGroupBy | null {
  const parsed = documentGroupBySchema.safeParse(params.get('groupBy'));
  return parsed.success ? parsed.data : null;
}

// Standing on a shelf, or stepping off it: the group's key goes into the filter that dimension is
// reachable by, and pressing the shelf already being stood on comes back off it (docs/11 §11.3).
function withGroup(filters: DocumentFilters, by: DocumentGroupBy, key: string): DocumentFilters {
  const param = DOCUMENT_GROUP_FILTER[by];
  const next: DocumentFilters = { ...filters };
  if (String(filters[param] ?? '') === key) {
    delete next[param];
    return next;
  }
  // The year is the one dimension whose filter is a number rather than a string; every other key is
  // an id or a place, and travels as it came.
  if (param === 'year') next.year = Number(key);
  else next[param] = key;
  return next;
}

// The shelves of one dimension, counted by the server under the filters in force (docs/07 §7.3).
type SectionSelection = {
  selected: string[];
  setSelected: (update: (current: string[]) => string[]) => void;
};

// The grid, arranged into the groups of one dimension (docs/11 §11.3). The headings and their counts
// come from the server, under the filters in force, so a heading says how much the archive holds
// rather than how much has been scrolled to.
function DocumentGroupSections({
  by,
  filters,
  sort,
  fields,
  selection,
}: {
  by: DocumentGroupBy;
  filters: DocumentFilters;
  sort: DocumentSort;
  fields: readonly DocumentCardField[];
  selection?: SectionSelection;
}) {
  const t = useTranslations();
  const groups = useQuery({
    queryKey: documentKeys.groups(by, filters),
    queryFn: () => documentApi.groups(by, filters),
  });

  if (groups.isPending) return <Spin />;

  const items = groups.data?.items ?? [];
  if (items.length === 0) {
    return <Typography.Text type="secondary">{t('documents.groupBy.empty')}</Typography.Text>;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      {items.map((group) => (
        <DocumentGroupSection
          key={group.key ?? '\u0000unassigned'}
          by={by}
          group={group}
          filters={filters}
          sort={sort}
          fields={fields}
          {...(selection === undefined ? {} : { selection })}
        />
      ))}
    </Space>
  );
}

// One section: its heading, and as many of its documents as have been asked for. Paged on its own,
// because one cursor cannot walk a grid whose order is now two levels deep (docs/11 §11.3).
function DocumentGroupSection({
  by,
  group,
  filters,
  sort,
  fields,
  selection,
}: {
  by: DocumentGroupBy;
  group: DocumentGroup;
  filters: DocumentFilters;
  sort: DocumentSort;
  fields: readonly DocumentCardField[];
  selection?: SectionSelection;
}) {
  const t = useTranslations();
  // A named group is the ordinary list filtered by its key; the group that has no key is the
  // ordinary list asked for what this dimension cannot place.
  const scope: DocumentFilters =
    group.key === null ? { ...filters, unassigned: by } : withGroup(filters, by, group.key);

  const documents = useInfiniteQuery({
    queryKey: documentKeys.list(scope, sort),
    queryFn: ({ pageParam }) =>
      documentApi.list(scope, { sort, ...(pageParam === '' ? {} : { cursor: pageParam }) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const items = (documents.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <section>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {/* The count is the archive's, the cards are as many as have been fetched — so the heading
            is a fact about the group rather than about the scrolling (docs/11 §11.3). */}
        {group.key === null
          ? t('documents.groupBy.unassigned', { count: group.count })
          : t('documents.groupBy.shelf', { label: group.label, count: group.count })}
      </Typography.Title>
      {documents.isPending ? (
        <Spin size="small" />
      ) : (
        <Row gutter={[16, 16]}>
          {items.map((document) => (
            <Col key={document.id} xs={12} sm={8} md={6} lg={4} xl={4} xxl={4}>
              <DocumentCard
                document={document}
                fields={fields}
                {...(selection === undefined
                  ? {}
                  : {
                      selection: {
                        picked: selection.selected.includes(document.id),
                        onToggle: () =>
                          selection.setSelected((current) =>
                            current.includes(document.id)
                              ? current.filter((id) => id !== document.id)
                              : [...current, document.id],
                          ),
                      },
                    })}
              />
            </Col>
          ))}
        </Row>
      )}
      {documents.hasNextPage === true && (
        <Button
          type="link"
          loading={documents.isFetchingNextPage}
          onClick={() => void documents.fetchNextPage()}
          style={{ paddingLeft: 0 }}
        >
          {t('documents.groupBy.more')}
        </Button>
      )}
    </section>
  );
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
