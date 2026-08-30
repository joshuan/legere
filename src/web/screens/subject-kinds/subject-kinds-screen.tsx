'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Form, Input, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { DEFAULT_CATALOGUE_SORT, subjectKindSortSchema } from '../../../shared/contracts/common';
import type { SubjectKindDto } from '../../../shared/contracts/subject-kinds';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { subjectKeys } from '../../entities/subject';
import { useIsAdmin } from '../../entities/user';
import {
  CatalogueManager,
  useCatalogueSort,
  type CatalogueSuggestionsReading,
} from '../../widgets/catalogue-manager';

type FormValues = { name: string; note: string };

// As much as `mergeSubjectKindsRequestSchema` accepts.
const NOTE_MAX = 500;

// /subject-kinds (docs/11 §11.12a): what sort of thing a subject may be. Renaming one here is
// a single edit for everything filed under it, which is the whole reason the kinds are a catalogue
// rather than a string on every row (docs/03 §3.3.20a). A configuration of the shared manager
// (M56.1): its columns, its words, its API.
export function SubjectKindsScreen() {
  const t = useTranslations();
  // The role comes from the layout's own answer, through context (docs/10 §10.2).
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  // The order the catalogue opens in; this one's sort enum admits `things` too (docs/07 §7.3).
  const sorting = useCatalogueSort(subjectKindSortSchema, DEFAULT_CATALOGUE_SORT);
  const kinds = useQuery({
    queryKey: subjectKindKeys.list(sorting.sort, sorting.order),
    queryFn: () => subjectKindApi.list({ sort: sorting.sort, order: sorting.order }),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: subjectKindKeys.all });
    // A kinds merge re-files things (docs/03 §3.3.20a), so the subjects list is stale with it.
    void queryClient.invalidateQueries({ queryKey: subjectKeys.all });
  }, [queryClient]);

  return (
    <CatalogueManager<SubjectKindDto, FormValues>
      title={t('admin.subjectKinds.title')}
      createLabel={t('admin.subjectKinds.actions.create')}
      createTitle={t('admin.subjectKinds.createTitle')}
      editTitle={t('admin.subjectKinds.editTitle')}
      emptyText={t('admin.subjectKinds.empty')}
      deletedMessage={t('admin.subjectKinds.deleted')}
      rows={kinds.data?.items ?? []}
      loading={kinds.isPending}
      columns={[
        {
          title: t('admin.catalogues.columns.name'),
          key: 'name',
          sortKey: 'name',
          render: (kind) => kind.name,
        },
        {
          title: t('admin.catalogues.columns.note'),
          key: 'note',
          render: (kind) => kind.note ?? <Typography.Text type="secondary">—</Typography.Text>,
        },
        {
          title: t('admin.subjectKinds.columns.subjects'),
          key: 'subjects',
          sortKey: 'things',
          // Every count on these screens is a question, and the answer is one click away
          // (docs/11 §11.12a): the things count opens /subjects filtered to this kind. Zero stays
          // plain text — there is nothing to go to.
          render: (kind) =>
            kind.subjectCount === 0 ? (
              0
            ) : (
              <Link href={`/subjects?kindId=${kind.id}`}>{kind.subjectCount}</Link>
            ),
        },
        {
          title: t('admin.catalogues.columns.documents'),
          key: 'documents',
          sortKey: 'documents',
          // ...and the documents count the browse, filtered by the same kind — the filter the API
          // already has (`?subjectKindId=`, docs/07 §7.3).
          render: (kind) =>
            kind.documentCount === 0 ? (
              0
            ) : (
              <Link href={`/documents?subjectKindId=${kind.id}`}>{kind.documentCount}</Link>
            ),
        },
        {
          // Across this kind's things (docs/07 §7.3), and the order the catalogue opens in.
          title: t('admin.catalogues.columns.lastDocument'),
          key: 'lastDocumentAt',
          sortKey: 'lastDocumentAt',
          render: (kind) =>
            kind.lastDocumentAt ?? <Typography.Text type="secondary">—</Typography.Text>,
        },
      ]}
      sorting={sorting}
      initialValues={{ name: '', note: '' }}
      valuesOf={(kind) => ({ name: kind.name, note: kind.note ?? '' })}
      // A kind still holding something cannot be removed at all, so the confirmation says what it
      // holds rather than promising a delete the server will refuse (docs/03 §3.3.20a).
      confirmDelete={(kind) =>
        kind.subjectCount > 0
          ? t('admin.subjectKinds.confirmDeleteInUse', {
              name: kind.name,
              count: kind.subjectCount,
            })
          : t('admin.subjectKinds.confirmDelete', { name: kind.name })
      }
      onSave={(values, editing) => {
        const note = values.note.trim() === '' ? null : values.note.trim();
        return editing === null
          ? subjectKindApi.create({ name: values.name, note })
          : subjectKindApi.update(editing.id, { name: values.name, note });
      }}
      onDelete={(kind) => subjectKindApi.remove(kind.id)}
      onSaved={refresh}
      // Anyone signed in may add — the analysis does, and whoever corrects it must be able to
      // (docs/03 §3.3.19–20a) — while renaming, deleting and merging reach across every document
      // that names the row, so they are an admin's.
      canCreate
      canManage={isAdmin}
      // One shelf spelled three ways files nothing well (docs/03 §3.3.20a): the merge moves every
      // thing the losing kinds held onto the survivor, folding the things both sides held.
      merge={{
        label: (kind) => kind.name,
        note: (kind) => kind.note,
        noteMaxLength: NOTE_MAX,
        onMerge: (rows, values) => {
          const note = (values.note ?? '').trim();
          return subjectKindApi.merge({
            ids: rows.map((kind) => kind.id),
            name: values.name ?? '',
            note: note === '' ? null : note,
          });
        },
        prefill: async (rows) => {
          const preview = await subjectKindApi
            .mergePreview({ ids: rows.map((kind) => kind.id) })
            .catch(() => null);
          if (preview === null || !preview.available || preview.name === null) return null;
          return { values: { name: preview.name }, aka: preview.aka ?? [], note: preview.note };
        },
      }}
      // The analyst's proposals (docs/05 §5.6c), on the manager's terms.
      suggestions={{
        title: t('admin.subjectKinds.suggestions.title'),
        queryKey: subjectKindKeys.mergeSuggestions,
        fetch: async ({ refresh }): Promise<CatalogueSuggestionsReading> => {
          const reading = await subjectKindApi.mergeSuggestions({ refresh });
          return {
            state: reading.state,
            computedAt: reading.computedAt,
            groups: reading.groups,
          };
        },
      }}
      fields={() => (
        <>
          <Form.Item
            name="name"
            label={t('admin.catalogues.fields.name')}
            rules={[{ required: true, message: t('admin.catalogues.fields.nameRequired') }]}
            extra={t('admin.subjectKinds.fields.nameHint')}
          >
            <Input placeholder="apartment" />
          </Form.Item>
          <Form.Item name="note" label={t('admin.catalogues.fields.note')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </>
      )}
    />
  );
}
