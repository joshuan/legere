'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Form, Input, Select, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { SubjectDto } from '../../../shared/contracts/subjects';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { CatalogueManager } from '../../widgets/catalogue-manager';

type FormValues = { kindId: string; name: string; note: string };

// /subjects (docs/11 §11.12a): the things documents are about. Both halves are editable — a
// boat filed as a country is corrected by moving it, not by deleting and retyping it
// (docs/03 §3.3.20).
export function SubjectsScreen({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const subjects = useQuery({ queryKey: subjectKeys.all, queryFn: subjectApi.list });
  const kinds = useQuery({ queryKey: subjectKindKeys.all, queryFn: subjectKindApi.list });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: subjectKeys.all });
    void queryClient.invalidateQueries({ queryKey: subjectKindKeys.all });
  }, [queryClient]);

  const kindOptions = (kinds.data?.items ?? []).map((kind) => ({
    value: kind.id,
    label: kind.name,
  }));

  return (
    <CatalogueManager<SubjectDto, FormValues>
      title={t('admin.subjects.title')}
      createLabel={t('admin.subjects.actions.create')}
      createTitle={t('admin.subjects.createTitle')}
      editTitle={t('admin.subjects.editTitle')}
      emptyText={t('admin.subjects.empty')}
      deletedMessage={t('admin.subjects.deleted')}
      rows={subjects.data?.items ?? []}
      loading={subjects.isPending}
      columns={[
        {
          title: t('admin.subjects.columns.kind'),
          key: 'kind',
          render: (subject) => <Tag>{subject.kind}</Tag>,
          // A catalogue of forty things is read one kind at a time.
          filters: (kinds.data?.items ?? []).map((kind) => ({
            text: kind.name,
            value: kind.id,
          })),
          onFilter: (value, subject) => subject.kindId === String(value),
        },
        { title: t('admin.catalogues.columns.name'), key: 'name', render: (s) => s.name },
        {
          title: t('admin.catalogues.columns.note'),
          key: 'note',
          render: (subject) =>
            subject.note ?? <Typography.Text type="secondary">—</Typography.Text>,
        },
        {
          title: t('admin.catalogues.columns.documents'),
          key: 'documents',
          // The number is the question "which four?"; the link answers it (docs/11 §11.12a).
          render: (subject) =>
            subject.documentCount === 0 ? (
              0
            ) : (
              <Link href={`/browse/subjects/${subject.kindId}/${subject.id}`}>
                {subject.documentCount}
              </Link>
            ),
        },
      ]}
      initialValues={{ kindId: '', name: '', note: '' }}
      valuesOf={(subject) => ({
        kindId: subject.kindId,
        name: subject.name,
        note: subject.note ?? '',
      })}
      confirmDelete={(subject) =>
        t('admin.subjects.confirmDelete', {
          name: subject.name,
          count: subject.documentCount,
        })
      }
      onSave={(values, editing) => {
        const note = values.note.trim() === '' ? null : values.note.trim();
        return editing === null
          ? subjectApi.create({ kindId: values.kindId, name: values.name, note })
          : subjectApi.update(editing.id, { kindId: values.kindId, name: values.name, note });
      }}
      onDelete={(subject) => subjectApi.remove(subject.id)}
      onSaved={refresh}
      // Anyone signed in may add — the analysis does, and whoever corrects it must be able to
      // (docs/03 §3.3.19–20a) — while renaming, deleting and merging reach across every document
      // that names the row, so they are an admin's.
      canCreate
      canManage={isAdmin}
      // One flat read four ways is what the analysis actually produces (docs/03 §3.3.20). The kind
      // travels too: the rows being folded together may disagree about it.
      merge={{
        label: (subject) => subject.name,
        // The note is what the analysis reads to tell one flat from another, so a merge keeps every
        // line of it rather than the survivor's alone (docs/11 §11.12a).
        note: (subject) => subject.note,
        // As much as `mergeSubjectsRequestSchema` accepts.
        noteMaxLength: 2000,
        initialValues: (rows) => ({
          name: rows[0]?.name ?? '',
          kindId: rows[0]?.kindId ?? '',
        }),
        fields: () => (
          <Form.Item
            name="kindId"
            label={t('admin.subjects.fields.kind')}
            rules={[{ required: true, message: t('admin.subjects.fields.kindRequired') }]}
          >
            <Select showSearch optionFilterProp="label" options={kindOptions} />
          </Form.Item>
        ),
        onMerge: (rows, values) => {
          const note = (values.note ?? '').trim();
          return subjectApi.merge({
            ids: rows.map((subject) => subject.id),
            kindId: values.kindId ?? '',
            name: values.name ?? '',
            note: note === '' ? null : note,
          });
        },
      }}
      fields={() => (
        <>
          <Form.Item
            name="kindId"
            label={t('admin.subjects.fields.kind')}
            rules={[{ required: true, message: t('admin.subjects.fields.kindRequired') }]}
            // Chosen from the catalogue, never typed: a kind is created where kinds are managed
            // (docs/03 §3.3.20a).
            extra={t('admin.subjects.fields.kindHint')}
          >
            <Select showSearch optionFilterProp="label" options={kindOptions} />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('admin.catalogues.fields.name')}
            rules={[{ required: true, message: t('admin.catalogues.fields.nameRequired') }]}
          >
            <Input />
          </Form.Item>
          {/* Not a footnote: this is what the analysis reads to tell one flat from another
              (docs/03 §3.3.20), so it is given room to be written in. */}
          <Form.Item
            name="note"
            label={t('admin.subjects.fields.note')}
            extra={t('admin.subjects.fields.noteHint')}
          >
            <Input.TextArea rows={4} maxLength={2000} showCount />
          </Form.Item>
        </>
      )}
    />
  );
}
