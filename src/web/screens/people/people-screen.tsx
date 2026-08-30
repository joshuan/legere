'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Form, Input, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { catalogueSortSchema, DEFAULT_CATALOGUE_SORT } from '../../../shared/contracts/common';
import type { PersonDto } from '../../../shared/contracts/people';
import { personApi, personKeys } from '../../entities/person';
import { useIsAdmin } from '../../entities/user';
import {
  CatalogueManager,
  useCatalogueSort,
  type CatalogueSuggestionsReading,
} from '../../widgets/catalogue-manager';

type FormValues = { name: string; note: string };

// As much as `mergePeopleRequestSchema` accepts.
const NOTE_MAX = 500;

// /people (docs/11 §11.12a): the catalogue the analysis writes into and a person corrects.
// Correcting it here rather than on a document is the point — a name spelled wrong on forty
// documents is one row, not forty edits (docs/03 §3.3.19). The screen is a configuration of the
// shared manager: its columns, its words, its API — the behavior lands once, in the widget (M56.1).
export function PeopleScreen() {
  const t = useTranslations();
  // The role comes from the layout's own answer, through context (docs/10 §10.2).
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  // The catalogue opens on who the paper spoke of most recently, and a header click sends the whole
  // question back to the server (docs/11 §11.12a).
  const sorting = useCatalogueSort(catalogueSortSchema, DEFAULT_CATALOGUE_SORT);
  const people = useQuery({
    queryKey: personKeys.list(sorting.sort, sorting.order),
    queryFn: () => personApi.list({ sort: sorting.sort, order: sorting.order }),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: personKeys.all });
  }, [queryClient]);

  return (
    <CatalogueManager<PersonDto, FormValues>
      title={t('admin.people.title')}
      createLabel={t('admin.people.actions.create')}
      createTitle={t('admin.people.createTitle')}
      editTitle={t('admin.people.editTitle')}
      emptyText={t('admin.people.empty')}
      deletedMessage={t('admin.people.deleted')}
      rows={people.data?.items ?? []}
      loading={people.isPending}
      columns={[
        {
          title: t('admin.catalogues.columns.name'),
          key: 'name',
          sortKey: 'name',
          render: (person) => person.name,
        },
        {
          title: t('admin.catalogues.columns.note'),
          key: 'note',
          render: (person) => person.note ?? <Typography.Text type="secondary">—</Typography.Text>,
        },
        {
          title: t('admin.catalogues.columns.documents'),
          key: 'documents',
          sortKey: 'documents',
          // The number is the question "which forty?"; the link answers it (docs/11 §11.12a).
          render: (person) =>
            person.documentCount === 0 ? (
              0
            ) : (
              <Link href={`/browse/people/${person.id}`}>{person.documentCount}</Link>
            ),
        },
        {
          // The paper's own date, not the day it was uploaded, and the order the catalogue opens in
          // (docs/11 §11.12a).
          title: t('admin.catalogues.columns.lastDocument'),
          key: 'lastDocumentAt',
          sortKey: 'lastDocumentAt',
          render: (person) =>
            person.lastDocumentAt ?? <Typography.Text type="secondary">—</Typography.Text>,
        },
      ]}
      sorting={sorting}
      initialValues={{ name: '', note: '' }}
      valuesOf={(person) => ({ name: person.name, note: person.note ?? '' })}
      confirmDelete={(person) =>
        t('admin.people.confirmDelete', { name: person.name, count: person.documentCount })
      }
      onSave={(values, editing) => {
        const note = values.note.trim() === '' ? null : values.note.trim();
        return editing === null
          ? personApi.create({ name: values.name, note })
          : personApi.update(editing.id, { name: values.name, note });
      }}
      onDelete={(person) => personApi.remove(person.id)}
      onSaved={refresh}
      // Anyone signed in may add — the analysis does, and whoever corrects it must be able to
      // (docs/03 §3.3.19–20a) — while renaming, deleting and merging reach across every document
      // that names the row, so they are an admin's.
      canCreate
      canManage={isAdmin}
      // The analysis reads a name as the document spells it, so one person arrives three times
      // (docs/03 §3.3.19).
      merge={{
        label: (person) => person.name,
        // What the merged rows carried, offered back as the survivor's note rather than dropped
        // (docs/11 §11.12a).
        note: (person) => person.note,
        noteMaxLength: NOTE_MAX,
        onMerge: (people, values) => {
          const note = (values.note ?? '').trim();
          return personApi.merge({
            ids: people.map((person) => person.id),
            name: values.name ?? '',
            note: note === '' ? null : note,
          });
        },
        // A hand-picked merge asks the analyst for the tidy reading while the raw prefill is
        // already on screen (docs/11 §11.12a); anything short of an answer keeps the raw one.
        prefill: async (rows) => {
          const preview = await personApi
            .mergePreview({ ids: rows.map((person) => person.id) })
            .catch(() => null);
          if (preview === null || !preview.available || preview.name === null) return null;
          return { values: { name: preview.name }, aka: preview.aka ?? [] };
        },
      }}
      // The analyst's proposals (docs/05 §5.6c), on the manager's terms; this screen only says
      // where to ask and what to call the panel.
      suggestions={{
        title: t('admin.people.suggestions.title'),
        queryKey: personKeys.mergeSuggestions,
        fetch: async (): Promise<CatalogueSuggestionsReading> => {
          const reading = await personApi.mergeSuggestions();
          return { state: reading.state, groups: reading.groups };
        },
      }}
      fields={() => (
        <>
          <Form.Item
            name="name"
            label={t('admin.catalogues.fields.name')}
            rules={[{ required: true, message: t('admin.catalogues.fields.nameRequired') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="note"
            label={t('admin.catalogues.fields.note')}
            extra={t('admin.people.fields.noteHint')}
          >
            <Input.TextArea rows={2} />
          </Form.Item>
        </>
      )}
    />
  );
}
