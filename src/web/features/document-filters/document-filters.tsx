'use client';

import { CloseOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Select, Space, Switch, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import type { FileOrigin } from '../../../shared/contracts/enums';
import type { DocumentFilters } from '../../entities/document';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { libraryApi, libraryKeys } from '../../entities/library';

export type DocumentFiltersProps = {
  value: DocumentFilters;
  onChange: (next: DocumentFilters) => void;
};

// The filter bar of docs/11 §11.3. It owns no state: the URL does, and this only reports changes —
// so a filtered view is a link somebody can send to a colleague.
export function DocumentFiltersBar({ value, onChange }: DocumentFiltersProps) {
  const t = useTranslations();

  const libraries = useQuery({ queryKey: libraryKeys.visible, queryFn: libraryApi.listVisible });
  const documentTypes = useQuery({ queryKey: documentTypeKeys.all, queryFn: documentTypeApi.list });

  const set = (patch: Partial<DocumentFilters>): void => {
    // An unset filter leaves no trace in the URL rather than sitting there as an empty parameter.
    const merged = { ...value, ...patch };
    const next: DocumentFilters = {};
    if (merged.libraryId !== undefined) next.libraryId = merged.libraryId;
    if (merged.typeId !== undefined) next.typeId = merged.typeId;
    // Filters that arrived from somewhere else — a name in the viewer's details pane is a link into
    // this screen (docs/11 §11.5) — have no control here, and are carried through rather than dropped
    // by the first switch anybody touches. "Clear filters" still takes them off, because it clears
    // what is in force rather than what is drawn.
    if (merged.personId !== undefined) next.personId = merged.personId;
    if (merged.subjectId !== undefined) next.subjectId = merged.subjectId;
    if (merged.subjectKindId !== undefined) next.subjectKindId = merged.subjectKindId;
    if (merged.year !== undefined) next.year = merged.year;
    if (merged.country !== undefined) next.country = merged.country;
    if (merged.city !== undefined) next.city = merged.city;
    if (merged.availability !== undefined) next.availability = merged.availability;
    if (merged.processing !== undefined) next.processing = merged.processing;
    if (merged.origin !== undefined) next.origin = merged.origin;
    // Both halves or neither: the API answers 422 to half of this pair, so half is never sent
    // (docs/07 §7.3, docs/11 §11.13).
    if (merged.step !== undefined && merged.stepStatus !== undefined) {
      next.step = merged.step;
      next.stepStatus = merged.stepStatus;
    }
    onChange(next);
  };

  const active = Object.keys(value).length > 0;

  return (
    <Space wrap size="middle">
      <Select
        allowClear
        style={{ minWidth: 200 }}
        placeholder={t('documents.filters.library')}
        aria-label={t('documents.filters.library')}
        loading={libraries.isPending}
        value={value.libraryId ?? undefined}
        onChange={(libraryId?: string) => set({ libraryId })}
        options={(libraries.data?.items ?? []).map((library) => ({
          value: library.id,
          label: library.name,
        }))}
      />

      <Select
        allowClear
        style={{ minWidth: 180 }}
        placeholder={t('documents.filters.documentType')}
        aria-label={t('documents.filters.documentType')}
        loading={documentTypes.isPending}
        value={value.typeId ?? undefined}
        onChange={(typeId?: string) => set({ typeId })}
        options={(documentTypes.data?.items ?? []).map((documentType) => ({
          value: documentType.id,
          label: documentType.name,
        }))}
      />

      {/* Where the document's files came from, and nothing finer: a document that absorbed an
          upload does not change kind, so there are two answers, not three (docs/03 §3.3.16). */}
      <Select
        allowClear
        style={{ minWidth: 180 }}
        placeholder={t('documents.filters.origin')}
        aria-label={t('documents.filters.origin')}
        value={value.origin ?? undefined}
        onChange={(origin?: FileOrigin) => set({ origin })}
        options={[
          { value: 'LIBRARY', label: t('documents.filters.originLibrary') },
          { value: 'MANAGED', label: t('documents.filters.originManaged') },
        ]}
      />

      <Space size="small">
        <Typography.Text type="secondary">{t('documents.filters.unavailableOnly')}</Typography.Text>
        <Switch
          aria-label={t('documents.filters.unavailableOnly')}
          checked={value.availability === 'UNAVAILABLE'}
          onChange={(on) => set({ availability: on ? 'UNAVAILABLE' : undefined })}
        />
      </Space>

      <Space size="small">
        <Typography.Text type="secondary">{t('documents.filters.processingOnly')}</Typography.Text>
        <Switch
          aria-label={t('documents.filters.processingOnly')}
          checked={value.processing === true}
          onChange={(on) => set({ processing: on ? true : undefined })}
        />
      </Space>

      {/* Arrived from a queue counter rather than chosen here, so it says in words what was clicked
          and comes off the same way anything else does (docs/11 §11.13). The step is named as the
          queue screen names it, because that is the number the reader pressed. */}
      {value.step !== undefined && value.stepStatus !== undefined && (
        <Tag
          color="processing"
          closable
          closeIcon={<CloseOutlined aria-label={t('documents.filters.stepClear')} />}
          onClose={() => set({ step: undefined, stepStatus: undefined })}
        >
          {t('documents.filters.step', {
            step: t(`admin.queue.steps.${value.step}`),
            status: t(`documents.filters.stepStatus.${value.stepStatus}`),
          })}
        </Tag>
      )}

      {active && <Button onClick={() => onChange({})}>{t('documents.filters.clear')}</Button>}
    </Space>
  );
}
