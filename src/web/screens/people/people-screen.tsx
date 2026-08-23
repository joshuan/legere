'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Space, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type { MergeSuggestionGroup, PersonDto } from '../../../shared/contracts/people';
import { personApi, personKeys } from '../../entities/person';
import { useIsAdmin } from '../../entities/user';
import { CatalogueManager, type MergeValues } from '../../widgets/catalogue-manager';

type FormValues = { name: string; note: string };

// As much as `mergePeopleRequestSchema` accepts.
const NOTE_MAX = 500;

// The survivor's note, composed the way the raw prefill composes it (docs/11 §11.12a) — the "also
// known as" line first, then every note the rows carried — only with the analyst's tidy spellings
// in place of the raw dump. Clamped where it is composed rather than where it is displayed.
function composedNote(akaLine: string | null, rows: readonly PersonDto[]): string {
  const notes = rows.map((person) => (person.note ?? '').trim()).filter((note) => note !== '');
  return [...(akaLine === null ? [] : [akaLine]), ...notes].join('\n').slice(0, NOTE_MAX);
}

// /people (docs/11 §11.12a): the catalogue the analysis writes into and a person corrects.
// Correcting it here rather than on a document is the point — a name spelled wrong on forty
// documents is one row, not forty edits (docs/03 §3.3.19).
export function PeopleScreen() {
  const t = useTranslations();
  // The role comes from the layout's own answer, through context (docs/10 §10.2).
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: personKeys.all, queryFn: personApi.list });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: personKeys.all });
  }, [queryClient]);

  // The analyst's proposals (docs/05 §5.6c). Asked once per visit and kept: a merged group leaves
  // the banner because its rows leave the catalogue, not because the server is asked again — the
  // server never remembers being refused, so re-asking is re-proposing.
  const suggestions = useQuery({
    queryKey: personKeys.mergeSuggestions,
    queryFn: personApi.mergeSuggestions,
    enabled: isAdmin,
    staleTime: Infinity,
  });
  const [bannerClosed, setBannerClosed] = useState(false);

  const alive = new Map((people.data?.items ?? []).map((person) => [person.id, person]));
  // A group survives only whole: a row merged or deleted since the answer takes its group with it.
  const groups = (suggestions.data?.configured === true ? suggestions.data.groups : []).filter(
    (group) => group.ids.every((id) => alive.has(id)),
  );

  const groupRows = (group: MergeSuggestionGroup): PersonDto[] =>
    group.ids.flatMap((id) => {
      const person = alive.get(id);
      return person === undefined ? [] : [person];
    });

  // The suggestion's aka line is the analyst's; a hand-picked merge asks for its own when the
  // dialog opens (docs/11 §11.12a).
  const akaLine = (aka: readonly string[]): string | null =>
    aka.length === 0 ? null : t('admin.catalogues.fields.alsoKnownAs', { names: aka.join(', ') });

  const suggestedValues = (group: MergeSuggestionGroup): MergeValues => ({
    name: group.name,
    note: composedNote(akaLine(group.aka), groupRows(group)),
  });

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
          return {
            name: preview.name,
            note: composedNote(akaLine(preview.aka ?? []), rows),
          };
        },
        // The screen notices first (docs/11 §11.12a): one row per group, and the same dialog.
        banner: (openMerge) =>
          bannerClosed || groups.length === 0 ? null : (
            <Alert
              type="info"
              showIcon
              closable
              style={{ marginBottom: 16 }}
              onClose={() => setBannerClosed(true)}
              message={t('admin.people.suggestions.title')}
              description={
                <Space direction="vertical" size="small">
                  {groups.map((group) => (
                    <Space key={group.ids.join(':')} wrap>
                      <Typography.Text>
                        {groupRows(group)
                          .map((person) => person.name)
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
          ),
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
