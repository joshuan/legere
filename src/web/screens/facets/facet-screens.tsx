'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Breadcrumb, Button, Card, Empty, List, Select, Space, Spin, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ZodType } from 'zod';
import {
  catalogueOrderSchema,
  catalogueSortSchema,
  subjectKindSortSchema,
} from '../../../shared/contracts/common';
import { documentApi, documentKeys, type DocumentFilters } from '../../entities/document';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { personApi, personKeys } from '../../entities/person';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { PageHeader, QueryError } from '../../shared/ui';
import { DocumentCard } from '../../widgets/document-card';
import { CatalogueCard } from '../../widgets/catalogue-card';

function useFacetSort<Sort extends string>(schema: ZodType<Sort>) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const sort = schema.parse(
    schema.safeParse(params.get('sort')).success ? params.get('sort') : 'documents',
  );
  const order = catalogueOrderSchema.catch('desc').parse(params.get('order'));
  const change = (value: string): void => {
    const [key, direction] = value.split(':');
    const next = new URLSearchParams(params);
    if (key === 'documents') next.delete('sort');
    else next.set('sort', schema.parse(key));
    if (direction === 'desc') next.delete('order');
    else next.set('order', catalogueOrderSchema.parse(direction));
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`);
  };
  return { sort, order, change };
}

function FacetSort({
  value,
  onChange,
  kinds = false,
}: {
  value: string;
  onChange: (value: string) => void;
  kinds?: boolean;
}) {
  const t = useTranslations();
  const keys = [
    'documents:desc',
    'documents:asc',
    'name:asc',
    'name:desc',
    'lastDocumentAt:desc',
    'lastDocumentAt:asc',
    ...(kinds ? ['things:desc', 'things:asc'] : []),
  ];
  return (
    <Select
      aria-label={t('catalogueCards.sortLabel')}
      value={value}
      onChange={onChange}
      style={{ width: 260, maxWidth: '100%' }}
      options={keys.map((key) => ({
        value: key,
        label: t(`catalogueCards.sorts.${key.replace(':', '_')}`),
      }))}
    />
  );
}

// Browsing by what a document *is about* rather than where its bytes are (docs/11 §11.4). Every
// facet is two screens — the folders, then what is in one — and the shelf itself is the same grid
// the documents screen uses, because a document looks the same wherever it is found.

// One folder: a name, and how many documents are behind it. Rendered as a list rather than as cards
// because a folder is a word, and a word does not need a picture.
function FolderList({
  items,
  empty,
}: {
  items: Array<{ href: string; title: string; note?: string | undefined; count: number }>;
  empty: string;
}) {
  if (items.length === 0) return <Empty description={empty} />;
  return (
    <List
      dataSource={items}
      renderItem={(item) => (
        <List.Item>
          <List.Item.Meta
            title={<Link href={item.href}>{item.title}</Link>}
            {...(item.note === undefined ? {} : { description: item.note })}
          />
          <Typography.Text type="secondary">{item.count}</Typography.Text>
        </List.Item>
      )}
    />
  );
}

// A shelf of one facet is read the way a shelf is read: by the date written on the paper
// (docs/11 §11.4). Asked for by name rather than inherited from the list's default, because an order
// belongs to a screen and not to a person — a screen that inherits one changes under its readers the
// day the home screen's default moves (docs/07 §7.3, docs/11 §11.3).
const FACET_SORT = 'documentDate';

// What is in one folder. The filter is whatever picked it — a type, a person, a thing, a year.
function FacetDocuments({ title, filters }: { title: string; filters: DocumentFilters }) {
  const t = useTranslations();
  const documents = useInfiniteQuery({
    queryKey: documentKeys.list(filters, FACET_SORT),
    queryFn: ({ pageParam }) =>
      documentApi.list(filters, {
        sort: FACET_SORT,
        cursor: pageParam === '' ? undefined : pageParam,
      }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const items = documents.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <PageHeader title={title} />
      <div>
        {documents.isError && documents.data !== undefined && (
          <QueryError error={documents.error} retry={documents.refetch} />
        )}
        {documents.isError && documents.data === undefined ? (
          <QueryError error={documents.error} retry={documents.refetch} />
        ) : documents.isPending ? (
          <Spin />
        ) : items.length === 0 ? (
          <Empty description={t('facets.emptyDocuments')} />
        ) : (
          <div className="legere-card-grid">
            {items.map((document) => (
              <div key={document.id}>
                <DocumentCard document={document} />
              </div>
            ))}
          </div>
        )}
        {documents.hasNextPage && (
          <Button
            loading={documents.isFetchingNextPage}
            onClick={() => void documents.fetchNextPage()}
          >
            {t('browse.more')}
          </Button>
        )}
      </div>
    </section>
  );
}

export function DocumentTypesFacetScreen() {
  const t = useTranslations();
  const documentTypes = useQuery({ queryKey: documentTypeKeys.all, queryFn: documentTypeApi.list });
  if (documentTypes.isPending) return <Spin />;
  if (documentTypes.isError && documentTypes.data === undefined)
    return <QueryError error={documentTypes.error} retry={documentTypes.refetch} />;

  return (
    <>
      {documentTypes.isError && (
        <QueryError error={documentTypes.error} retry={documentTypes.refetch} />
      )}

      <PageHeader title={t('facets.types')} />
      <Card size="small">
        <FolderList
          empty={t('facets.emptyTypes')}
          items={(documentTypes.data?.items ?? []).map((type) => ({
            href: `/browse/types/${type.id}`,
            title: type.name,
            note: type.description ?? undefined,
            count: type.documentCount,
          }))}
        />
      </Card>
    </>
  );
}

export function PeopleFacetScreen() {
  const t = useTranslations();
  const people = useQuery({ queryKey: personKeys.all, queryFn: () => personApi.list() });
  if (people.isPending) return <Spin />;
  if (people.isError && people.data === undefined)
    return <QueryError error={people.error} retry={people.refetch} />;

  return (
    <>
      {people.isError && <QueryError error={people.error} retry={people.refetch} />}

      <PageHeader title={t('facets.people')} />
      <Card size="small">
        <FolderList
          empty={t('facets.emptyPeople')}
          items={(people.data?.items ?? []).map((person) => ({
            href: `/browse/people/${person.id}`,
            title: person.name,
            note: person.note ?? undefined,
            count: person.documentCount,
          }))}
        />
      </Card>
    </>
  );
}

// Two levels, because a subject has a kind and a kind is exactly what a folder is: all the flats,
// then which flat (docs/03 §3.3.20).
export function SubjectKindsFacetScreen() {
  const t = useTranslations();
  const sorting = useFacetSort(subjectKindSortSchema);
  // The catalogue itself, not the kinds that happen to be in use: an empty folder is a shelf with
  // nothing on it yet, which is different from a shelf that does not exist (docs/03 §3.3.20a).
  const kinds = useQuery({
    queryKey: subjectKindKeys.list(sorting.sort, sorting.order),
    queryFn: () => subjectKindApi.list(sorting),
  });
  if (kinds.isPending) return <Spin />;
  if (kinds.isError && kinds.data === undefined)
    return <QueryError error={kinds.error} retry={kinds.refetch} />;

  return (
    <>
      {kinds.isError && <QueryError error={kinds.error} retry={kinds.refetch} />}

      <PageHeader title={t('facets.subjects')} />
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <FacetSort value={`${sorting.sort}:${sorting.order}`} onChange={sorting.change} kinds />
        {(kinds.data?.items.length ?? 0) === 0 ? (
          <Empty description={t('facets.emptySubjects')} />
        ) : (
          <div className="legere-card-grid">
            {kinds.data?.items.map((kind) => (
              <CatalogueCard
                key={kind.id}
                target="subject-kinds"
                item={kind}
                href={`/browse/subjects/${kind.id}`}
              />
            ))}
          </div>
        )}
      </Space>
    </>
  );
}

export function SubjectsOfKindFacetScreen({ kindId, title }: { kindId: string; title: string }) {
  const t = useTranslations();
  const sorting = useFacetSort(catalogueSortSchema);
  const subjects = useQuery({
    queryKey: subjectKeys.list(sorting.sort, sorting.order),
    queryFn: () => subjectApi.list(sorting),
  });
  if (subjects.isPending) return <Spin />;
  if (subjects.isError && subjects.data === undefined)
    return <QueryError error={subjects.error} retry={subjects.refetch} />;

  const items = (subjects.data?.items ?? []).filter((subject) => subject.kindId === kindId);

  return (
    <>
      {subjects.isError && <QueryError error={subjects.error} retry={subjects.refetch} />}

      <Breadcrumb
        items={[{ title: <Link href="/browse/subjects">{t('facets.subjects')}</Link> }, { title }]}
      />
      <PageHeader title={title} />
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <FacetSort value={`${sorting.sort}:${sorting.order}`} onChange={sorting.change} />
        {items.length === 0 ? (
          <Empty description={t('facets.emptySubjects')} />
        ) : (
          <div className="legere-card-grid">
            {items.map((subject) => (
              <CatalogueCard
                key={subject.id}
                target="subjects"
                item={subject}
                href={`/browse/subjects/${kindId}/${subject.id}`}
              />
            ))}
          </div>
        )}
      </Space>
    </>
  );
}

export function YearsFacetScreen() {
  const t = useTranslations();
  const years = useQuery({ queryKey: documentKeys.years, queryFn: documentApi.years });
  if (years.isPending) return <Spin />;
  if (years.isError && years.data === undefined)
    return <QueryError error={years.error} retry={years.refetch} />;

  return (
    <>
      {years.isError && <QueryError error={years.error} retry={years.refetch} />}

      <PageHeader title={t('facets.years')} />
      <Card size="small">
        <FolderList
          empty={t('facets.emptyYears')}
          items={(years.data?.items ?? []).map((entry) => ({
            href: `/browse/years/${entry.year}`,
            title: String(entry.year),
            count: entry.count,
          }))}
        />
      </Card>
    </>
  );
}

export function DocumentsOfTypeScreen({ id, title }: { id: string; title: string }) {
  return <FacetDocuments title={title} filters={{ typeId: id }} />;
}

export function DocumentsOfPersonScreen({ id, title }: { id: string; title: string }) {
  return <FacetDocuments title={title} filters={{ personId: id }} />;
}

export function DocumentsOfYearScreen({ year }: { year: number }) {
  return <FacetDocuments title={String(year)} filters={{ year }} />;
}
