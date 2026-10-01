'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Divider, Modal, Space, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type DocumentDetailDto } from '../../../../shared/contracts/documents';
import { documentApi } from '../../../entities/document';
import { useErrorMessage, formatBytes } from '../../../shared/lib';

// 🔒 The one control in Legere that destroys anything (docs/03 §3.3.10, docs/11 §11.5d). At the foot
// of the Files tab, under the rows it is about to count: a deletion is a decision about the bytes,
// and the whole list stands between it and Download at the top — a destructive action sharing an
// edge with Download is one somebody presses by accident.
//
// The confirmation is a modal rather than a popover because it has an inventory to read out: what
// goes, and — the part nobody can infer — what stays and what will happen to it.
export function DeleteSection({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [asking, setAsking] = useState(false);

  // The originals that outlive the document, because they are on a volume Legere may not write to
  // (docs/03 §3.3.9). A document made only of uploads has none, and is not told about a kept file
  // that does not exist.
  const onVolume = document.files.filter((file) => file.refs.length > 0).length;

  const remove = useMutation({
    mutationFn: () => documentApi.remove(document.id),
    onSuccess: () => {
      setAsking(false);
      void message.success(t('viewer.delete.done'), 3);
      // The archive is re-fetched, and the reader is taken off an address that no longer resolves.
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      router.push('/documents');
    },
    // The modal stays open on a failure, with the error where it happened.
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  return (
    // A rule of its own above it, and nothing after it: this is where the tab ends (docs/11 §11.5d).
    <>
      <Divider style={{ marginBottom: 16 }} />
      <Button danger onClick={() => setAsking(true)}>
        {t('viewer.delete.action')}
      </Button>

      <Modal
        open={asking}
        title={t('viewer.delete.title', { title: document.title })}
        okText={t('viewer.delete.action')}
        okType="danger"
        okButtonProps={{ type: 'primary', danger: true }}
        cancelText={t('common.actions.cancel')}
        confirmLoading={remove.isPending}
        onCancel={() => setAsking(false)}
        onOk={() => remove.mutate()}
      >
        <Space orientation="vertical" size="small">
          <Typography.Text>
            {t('viewer.delete.goes', {
              files: document.files.length,
              size: formatBytes(document.sizeBytes),
            })}
          </Typography.Text>
          {onVolume > 0 && (
            <Typography.Text type="secondary">
              {t('viewer.delete.kept', { files: onVolume })}
            </Typography.Text>
          )}
          <Typography.Text type="warning">{t('viewer.delete.forGood')}</Typography.Text>
        </Space>
      </Modal>
    </>
  );
}
