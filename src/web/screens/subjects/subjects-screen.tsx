'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Form, Input, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import type { SubjectDto, SubjectMergeSuggestionGroup } from '../../../shared/contracts/subjects';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { useIsAdmin } from '../../entities/user';
import { useErrorMessage } from '../../shared/lib';
import { CatalogueManager, type MergeValues } from '../../widgets/catalogue-manager';

type FormValues = { kindId: string; name: string; note: string };

// As much as `mergeSubjectsRequestSchema` accepts.
const NOTE_MAX = 2000;

// The survivor's note, composed the way the raw prefill composes it (docs/11 §11.12a) — the "also
// known as" line first, then every note the rows carried — with the analyst's tidy spellings in
// place of the raw dump. Clamped where it is composed rather than where it is displayed.
function composedNote(akaLine: string | null, rows: readonly SubjectDto[]): string {
  const notes = rows.map((subject) => (subject.note ?? '').trim()).filter((note) => note !== '');
  return [...(akaLine === null ? [] : [akaLine]), ...notes].join('\n').slice(0, NOTE_MAX);
}

// /subjects (docs/11 §11.12a): the things documents are about. Both halves are editable — a
// boat filed as a country is corrected by moving it, not by deleting and retyping it
// (docs/03 §3.3.20).
export function SubjectsScreen() {
  const t = useTranslations();
  // The role comes from the layout's own answer, through context (docs/10 §10.2).
  const isAdmin = useIsAdmin();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
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

  // The analyst's proposals (docs/05 §5.6c). Asked once per visit and kept: a merged group leaves
  // the banner because its rows leave the catalogue, not because the server is asked again.
  const suggestions = useQuery({
    queryKey: subjectKeys.mergeSuggestions,
    queryFn: subjectApi.mergeSuggestions,
    enabled: isAdmin,
    staleTime: Infinity,
  });
  const [bannerClosed, setBannerClosed] = useState(false);

  const alive = new Map((subjects.data?.items ?? []).map((subject) => [subject.id, subject]));
  const groups = (suggestions.data?.configured === true ? suggestions.data.groups : []).filter(
    (group) => group.ids.every((id) => alive.has(id)),
  );
  const placeholders = (
    suggestions.data?.configured === true ? suggestions.data.placeholders : []
  ).flatMap((id) => {
    const subject = alive.get(id);
    return subject === undefined ? [] : [subject];
  });

  const groupRows = (group: SubjectMergeSuggestionGroup): SubjectDto[] =>
    group.ids.flatMap((id) => {
      const subject = alive.get(id);
      return subject === undefined ? [] : [subject];
    });

  const akaLine = (aka: readonly string[]): string | null =>
    aka.length === 0 ? null : t('admin.catalogues.fields.alsoKnownAs', { names: aka.join(', ') });

  const suggestedValues = (group: SubjectMergeSuggestionGroup): MergeValues => ({
    name: group.name,
    kindId: group.kindId,
    note: composedNote(akaLine(group.aka), groupRows(group)),
  });

  // Deleting a placeholder is the ordinary delete, from the banner (docs/11 §11.12a): analysis
  // noise goes one confirmed row at a time.
  const removePlaceholder = useMutation({
    mutationFn: (subject: SubjectDto) => subjectApi.remove(subject.id),
    onSuccess: () => {
      void message.success(t('admin.subjects.deleted'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

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
        // A hand-picked merge asks the analyst for the tidy reading — name, kind and spellings —
        // while the raw prefill is already on screen (docs/11 §11.12a).
        prefill: async (rows) => {
          const preview = await subjectApi
            .mergePreview({ ids: rows.map((subject) => subject.id) })
            .catch(() => null);
          if (preview === null || !preview.available || preview.name === null) return null;
          return {
            name: preview.name,
            ...(preview.kindId === null ? {} : { kindId: preview.kindId }),
            note: composedNote(akaLine(preview.aka ?? []), rows),
          };
        },
        // The screen notices first (docs/11 §11.12a): the groups, and beside them the rows that
        // name a kind rather than a thing.
        banner: (openMerge) =>
          bannerClosed || (groups.length === 0 && placeholders.length === 0) ? null : (
            <Alert
              type="info"
              showIcon
              closable
              style={{ marginBottom: 16 }}
              onClose={() => setBannerClosed(true)}
              message={t('admin.subjects.suggestions.title')}
              description={
                <Space direction="vertical" size="small">
                  {groups.map((group) => (
                    <Space key={group.ids.join(':')} wrap>
                      <Typography.Text>
                        {groupRows(group)
                          .map((subject) => `${subject.kind}: ${subject.name}`)
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
                  {placeholders.length > 0 && (
                    <Typography.Text strong>
                      {t('admin.subjects.suggestions.placeholdersTitle')}
                    </Typography.Text>
                  )}
                  {placeholders.map((subject) => (
                    <Space key={subject.id} wrap>
                      <Typography.Text>
                        {subject.kind}: {subject.name}
                      </Typography.Text>
                      <Popconfirm
                        title={t('admin.subjects.confirmDelete', {
                          name: subject.name,
                          count: subject.documentCount,
                        })}
                        okText={t('common.yes')}
                        cancelText={t('common.actions.cancel')}
                        onConfirm={() => removePlaceholder.mutate(subject)}
                      >
                        <Button size="small" danger>
                          {t('common.actions.delete')}
                        </Button>
                      </Popconfirm>
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
