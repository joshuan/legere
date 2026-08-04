'use client';

import { useQuery } from '@tanstack/react-query';
import { Button, Select, Space, Switch, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import type { DocumentSource } from '../../../shared/contracts/enums';
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
    if (merged.availability !== undefined) next.availability = merged.availability;
    if (merged.processing !== undefined) next.processing = merged.processing;
    if (merged.source !== undefined) next.source = merged.source;
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

      <Select
        allowClear
        style={{ minWidth: 180 }}
        placeholder={t('documents.filters.source')}
        aria-label={t('documents.filters.source')}
        value={value.source ?? undefined}
        onChange={(source?: DocumentSource) => set({ source })}
        options={[
          { value: 'LIBRARY', label: t('documents.filters.sourceLibrary') },
          { value: 'UPLOAD', label: t('documents.filters.sourceUpload') },
          { value: 'DERIVED', label: t('documents.filters.sourceDerived') },
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

      {active && <Button onClick={() => onChange({})}>{t('documents.filters.clear')}</Button>}
    </Space>
  );
}
