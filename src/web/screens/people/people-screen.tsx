'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Form, Input, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { PersonDto } from '../../../shared/contracts/people';
import { personApi, personKeys } from '../../entities/person';
import { CatalogueManager } from '../../widgets/catalogue-manager';

type FormValues = { name: string; note: string };

// /people (docs/11 §11.12a): the catalogue the analysis writes into and a person corrects.
// Correcting it here rather than on a document is the point — a name spelled wrong on forty
// documents is one row, not forty edits (docs/03 §3.3.19).
export function PeopleScreen({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: personKeys.all, queryFn: personApi.list });

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
          // The number is the question "which forty?"; the link answers it (docs/11 §11.12a).
          render: (person) =>
            person.documentCount === 0 ? (
              0
            ) : (
              <Link href={`/browse/people/${person.id}`}>{person.documentCount}</Link>
            ),
        },
      ]}
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
        // As much as `mergePeopleRequestSchema` accepts.
        noteMaxLength: 500,
        onMerge: (people, values) => {
          const note = (values.note ?? '').trim();
          return personApi.merge({
            ids: people.map((person) => person.id),
            name: values.name ?? '',
            note: note === '' ? null : note,
          });
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
