'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Form, Input, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { SubjectKindDto } from '../../../shared/contracts/subject-kinds';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { useIsAdmin } from '../../entities/user';
import { CatalogueManager } from '../../widgets/catalogue-manager';

type FormValues = { name: string; note: string };

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
