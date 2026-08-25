'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, Col, Empty, List, Row, Spin, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { documentApi, documentKeys, type DocumentFilters } from '../../entities/document';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { personApi, personKeys } from '../../entities/person';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { DocumentCard } from '../../widgets/document-card';

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
  const documents = useQuery({
    queryKey: documentKeys.list(filters, FACET_SORT),
    queryFn: () => documentApi.list(filters, { sort: FACET_SORT }),
  });

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          {title}
        </Typography.Title>
      </Col>
      <Col span={24}>
        {documents.isPending ? (
          <Spin />
        ) : (documents.data?.items ?? []).length === 0 ? (
          <Empty description={t('facets.emptyDocuments')} />
        ) : (
          <div className="legere-card-grid">
            {(documents.data?.items ?? []).map((document) => (
              <div key={document.id}>
                <DocumentCard document={document} />
              </div>
            ))}
          </div>
        )}
      </Col>
    </Row>
  );
}

export function DocumentTypesFacetScreen() {
  const t = useTranslations();
  const documentTypes = useQuery({ queryKey: documentTypeKeys.all, queryFn: documentTypeApi.list });
  if (documentTypes.isPending) return <Spin />;

  return (
    <Card title={t('facets.types')}>
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
  );
}

export function PeopleFacetScreen() {
  const t = useTranslations();
  const people = useQuery({ queryKey: personKeys.all, queryFn: personApi.list });
  if (people.isPending) return <Spin />;

  return (
    <Card title={t('facets.people')}>
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
  );
}

// Two levels, because a subject has a kind and a kind is exactly what a folder is: all the flats,
// then which flat (docs/03 §3.3.20).
export function SubjectKindsFacetScreen() {
  const t = useTranslations();
  // The catalogue itself, not the kinds that happen to be in use: an empty folder is a shelf with
  // nothing on it yet, which is different from a shelf that does not exist (docs/03 §3.3.20a).
  const kinds = useQuery({ queryKey: subjectKindKeys.all, queryFn: subjectKindApi.list });
  if (kinds.isPending) return <Spin />;

  return (
    <Card title={t('facets.subjects')}>
      <FolderList
        empty={t('facets.emptySubjects')}
        items={(kinds.data?.items ?? []).map((kind) => ({
          href: `/browse/subjects/${kind.id}`,
          title: kind.name,
          note: kind.note ?? undefined,
          count: kind.documentCount,
        }))}
      />
    </Card>
  );
}

export function SubjectsOfKindFacetScreen({ kindId, title }: { kindId: string; title: string }) {
  const t = useTranslations();
  const subjects = useQuery({ queryKey: subjectKeys.all, queryFn: subjectApi.list });
  if (subjects.isPending) return <Spin />;

  const items = (subjects.data?.items ?? []).filter((subject) => subject.kindId === kindId);

  return (
    <Card title={title}>
      <FolderList
        empty={t('facets.emptySubjects')}
        items={items.map((subject) => ({
          href: `/browse/subjects/${kindId}/${subject.id}`,
          title: subject.name,
          note: subject.note ?? undefined,
          count: subject.documentCount,
        }))}
      />
    </Card>
  );
}

export function YearsFacetScreen() {
  const t = useTranslations();
  const years = useQuery({ queryKey: documentKeys.years, queryFn: documentApi.years });
  if (years.isPending) return <Spin />;

  return (
    <Card title={t('facets.years')}>
      <FolderList
        empty={t('facets.emptyYears')}
        items={(years.data?.items ?? []).map((entry) => ({
          href: `/browse/years/${entry.year}`,
          title: String(entry.year),
          count: entry.count,
        }))}
      />
    </Card>
  );
}

export function DocumentsOfTypeScreen({ id, title }: { id: string; title: string }) {
  return <FacetDocuments title={title} filters={{ typeId: id }} />;
}

export function DocumentsOfPersonScreen({ id, title }: { id: string; title: string }) {
  return <FacetDocuments title={title} filters={{ personId: id }} />;
}

export function DocumentsOfSubjectScreen({ id, title }: { id: string; title: string }) {
  return <FacetDocuments title={title} filters={{ subjectId: id }} />;
}

export function DocumentsOfYearScreen({ year }: { year: number }) {
  return <FacetDocuments title={String(year)} filters={{ year }} />;
}
