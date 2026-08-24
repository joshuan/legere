'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Space, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type {
  SubjectKindDto,
  SubjectKindMergeSuggestionGroup,
} from '../../../shared/contracts/subject-kinds';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { subjectKeys } from '../../entities/subject';
import { useIsAdmin } from '../../entities/user';
import {
  AnalystUnavailableNotice,
  CatalogueManager,
  type MergeValues,
} from '../../widgets/catalogue-manager';

type FormValues = { name: string; note: string };

// As much as `mergeSubjectKindsRequestSchema` accepts.
const NOTE_MAX = 500;

function composedNote(akaLine: string | null, rows: readonly SubjectKindDto[]): string {
  const notes = rows.map((kind) => (kind.note ?? '').trim()).filter((note) => note !== '');
  return [...(akaLine === null ? [] : [akaLine]), ...notes].join('\n').slice(0, NOTE_MAX);
}

// /subject-kinds (docs/11 §11.12a): what sort of thing a subject may be. Renaming one here is
// a single edit for everything filed under it, which is the whole reason the kinds are a catalogue
// rather than a string on every row (docs/03 §3.3.20a).
export function SubjectKindsScreen() {
  const t = useTranslations();
  // The role comes from the layout's own answer, through context (docs/10 §10.2).
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const kinds = useQuery({ queryKey: subjectKindKeys.all, queryFn: subjectKindApi.list });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: subjectKindKeys.all });
    // A kinds merge re-files things (docs/03 §3.3.20a), so the subjects list is stale with it.
    void queryClient.invalidateQueries({ queryKey: subjectKeys.all });
  }, [queryClient]);

  // The analyst's proposals (docs/05 §5.6c), on the people screen's terms.
  const suggestions = useQuery({
    queryKey: subjectKindKeys.mergeSuggestions,
    queryFn: subjectKindApi.mergeSuggestions,
    enabled: isAdmin,
    staleTime: Infinity,
  });
  const [bannerClosed, setBannerClosed] = useState(false);

  const alive = new Map((kinds.data?.items ?? []).map((kind) => [kind.id, kind]));
  const groups = (suggestions.data?.state === 'ANSWERED' ? suggestions.data.groups : []).filter(
    (group) => group.ids.every((id) => alive.has(id)),
  );
  // Asked, and could not answer (docs/05 §5.6c) — said rather than drawn as an empty table.
  const unavailable = suggestions.data?.state === 'UNAVAILABLE';

  const groupRows = (group: SubjectKindMergeSuggestionGroup): SubjectKindDto[] =>
    group.ids.flatMap((id) => {
      const kind = alive.get(id);
      return kind === undefined ? [] : [kind];
    });

  const akaLine = (aka: readonly string[]): string | null =>
    aka.length === 0 ? null : t('admin.catalogues.fields.alsoKnownAs', { names: aka.join(', ') });

  const suggestedValues = (group: SubjectKindMergeSuggestionGroup): MergeValues => ({
    name: group.name,
    note: composedNote(akaLine(group.aka), groupRows(group)),
  });

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
        { title: t('admin.catalogues.columns.name'), key: 'name', render: (kind) => kind.name },
        {
          title: t('admin.catalogues.columns.note'),
          key: 'note',
          render: (kind) => kind.note ?? <Typography.Text type="secondary">—</Typography.Text>,
        },
        {
          title: t('admin.subjectKinds.columns.subjects'),
          key: 'subjects',
          render: (kind) => kind.subjectCount,
        },
        {
          title: t('admin.catalogues.columns.documents'),
          key: 'documents',
          render: (kind) => kind.documentCount,
        },
      ]}
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
          return {
            name: preview.name,
            note: composedNote(akaLine(preview.aka ?? []), rows),
          };
        },
        banner: (openMerge) => {
          if (bannerClosed) return null;
          if (unavailable)
            return <AnalystUnavailableNotice onClose={() => setBannerClosed(true)} />;
          if (groups.length === 0) return null;
          return (
            <Alert
              type="info"
              showIcon
              closable
              style={{ marginBottom: 16 }}
              onClose={() => setBannerClosed(true)}
              message={t('admin.subjectKinds.suggestions.title')}
              description={
                <Space direction="vertical" size="small">
                  {groups.map((group) => (
                    <Space key={group.ids.join(':')} wrap>
                      <Typography.Text>
                        {groupRows(group)
                          .map((kind) => kind.name)
                          .join(', ')}
                      </Typography.Text>
                      <Button
                        size="small"
                        onClick={() => openMerge(groupRows(group), suggestedValues(group))}
                      >
                        {t('admin.catalogues.actions.merge', { count: group.ids.length })}
                      </Button>
                    </Space>
                  ))}
                </Space>
              }
            />
          );
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
