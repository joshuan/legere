'use client';

import { PictureOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Modal, Space, Tooltip, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  MAX_CATALOGUE_ICON_BYTES,
  catalogueSymbolSchema,
  type CatalogueIcon,
  type CatalogueIconTarget,
  type CatalogueSymbol,
} from '../../../shared/contracts/catalogue-icons';
import {
  CatalogueIconView,
  CatalogueSymbolIcon,
  catalogueIconApi,
} from '../../entities/catalogue-icon';
import { subjectKeys } from '../../entities/subject';
import { subjectKindKeys } from '../../entities/subject-kind';
import { useErrorMessage } from '../../shared/lib';

export function EditCatalogueIcon({
  target,
  id,
  name,
  icon,
}: {
  target: CatalogueIconTarget;
  id: string;
  name: string;
  icon: CatalogueIcon | null;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title={t('catalogueCards.editIcon', { name })}>
        <Button
          className="legere-catalogue-edit"
          type="text"
          icon={<PictureOutlined />}
          aria-label={t('catalogueCards.editIcon', { name })}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      {open && (
        <IconEditor
          target={target}
          id={id}
          name={name}
          icon={icon}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function IconEditor({
  target,
  id,
  name,
  icon,
  onClose,
}: {
  target: CatalogueIconTarget;
  id: string;
  name: string;
  icon: CatalogueIcon | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const queries = useQueryClient();
  const [symbol, setSymbol] = useState<CatalogueSymbol | null>(
    icon?.type === 'symbol' ? icon.symbol : null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [changed, setChanged] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  useEffect(() => {
    return () => readerRef.current?.abort();
  }, []);
  const save = useMutation({
    mutationFn: () =>
      file === null
        ? catalogueIconApi.symbol(target, id, symbol)
        : catalogueIconApi.upload(target, id, file),
    onSuccess: async () => {
      await Promise.all([
        queries.invalidateQueries({ queryKey: subjectKeys.all }),
        queries.invalidateQueries({ queryKey: subjectKindKeys.all }),
      ]);
      void message.success(t('catalogueCards.iconSaved'));
      onClose();
    },
  });
  const choose = (next: CatalogueSymbol | null): void => {
    setSymbol(next);
    readerRef.current?.abort();
    setFile(null);
    setPreview(null);
    setChanged(true);
    setFileError(null);
    save.reset();
  };
  return (
    <Modal
      open
      title={t('catalogueCards.editIcon', { name })}
      onCancel={onClose}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      onOk={() => save.mutate()}
      confirmLoading={save.isPending}
      okButtonProps={{ disabled: !changed || fileError !== null }}
      closable={!save.isPending}
      mask={{ closable: !save.isPending }}
      cancelButtonProps={{ disabled: save.isPending }}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <div className="legere-catalogue-icon-preview">
          {preview !== null ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="legere-catalogue-logo" />
          ) : (
            <CatalogueIconView
              icon={changed ? (symbol === null ? null : { type: 'symbol', symbol }) : icon}
              target={target}
              id={id}
            />
          )}
        </div>
        <div
          className="legere-catalogue-symbols"
          role="radiogroup"
          aria-label={t('catalogueCards.chooseIcon')}
        >
          {catalogueSymbolSchema.options.map((value) => (
            <Tooltip key={value} title={t(`catalogueCards.symbols.${value}`)}>
              <button
                type="button"
                role="radio"
                aria-checked={file === null && symbol === value}
                aria-label={t(`catalogueCards.symbols.${value}`)}
                disabled={save.isPending}
                onClick={() => choose(value)}
              >
                <CatalogueSymbolIcon symbol={value} />
              </button>
            </Tooltip>
          ))}
        </div>
        <Space wrap>
          <Button
            icon={<UploadOutlined />}
            disabled={save.isPending}
            onClick={() => inputRef.current?.click()}
          >
            {t('catalogueCards.uploadLogo')}
          </Button>
          <Button disabled={save.isPending} onClick={() => choose(null)}>
            {t('catalogueCards.defaultIcon')}
          </Button>
        </Space>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label={t('catalogueCards.uploadLogo')}
          onChange={(event) => {
            const next = event.target.files?.[0];
            event.target.value = '';
            if (next === undefined) return;
            if (next.size > MAX_CATALOGUE_ICON_BYTES) {
              setFileError(t('catalogueCards.tooLarge'));
              return;
            }
            setFile(next);
            setPreview(null);
            readerRef.current?.abort();
            // The application permits data images; blob URLs are deliberately outside its CSP.
            const reader = new FileReader();
            readerRef.current = reader;
            reader.onload = () => {
              if (typeof reader.result === 'string') setPreview(reader.result);
            };
            reader.onerror = () => setFileError(t('catalogueCards.readError'));
            reader.readAsDataURL(next);
            setChanged(true);
            setFileError(null);
            save.reset();
          }}
        />
        <Typography.Text type="secondary">{t('catalogueCards.logoHint')}</Typography.Text>
        {(fileError !== null || save.error !== null) && (
          <Alert type="error" showIcon title={fileError ?? describeError(save.error)} />
        )}
      </Space>
    </Modal>
  );
}
