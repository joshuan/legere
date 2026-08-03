'use client';

import { InboxOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Button, Upload } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useTranslations } from 'next-intl';
import { useCallback, useState, type ReactNode } from 'react';
import { documentApi } from '../../entities/document';
import { useErrorMessage } from '../../shared/lib';

// Uploading from the browser (docs/11 §11.3). Two affordances over one mutation: a button in the
// header and a drop zone wrapped around the grid, because people reach for whichever is nearer.
export function useDocumentUpload() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [pending, setPending] = useState(0);

  const upload = useMutation({
    mutationFn: (file: File) => documentApi.upload(file),
    onSuccess: (result, file) => {
      // A document that was already here is not an error — it is deduplication doing its job, and
      // saying so is more useful than a silent no-op (ADR-009).
      void message.success(
        result.created
          ? t('documents.upload.done', { name: file.name })
          : t('documents.upload.duplicate', { name: file.name }),
        3,
      );
      // Every filter combination shows a different slice, and a new document may belong to any of
      // them; the shared prefix invalidates the lot.
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error: unknown, file) => {
      // Per file: one rejected upload must not stop the rest of a dropped batch.
      void message.error(`${file.name}: ${describeError(error)}`);
    },
    onSettled: () => setPending((count) => Math.max(0, count - 1)),
  });

  const send = useCallback(
    (file: File) => {
      setPending((count) => count + 1);
      upload.mutate(file);
    },
    [upload],
  );

  return { send, pending, busy: pending > 0 };
}

export function UploadButton({ onFiles }: { onFiles: (file: File) => void }) {
  const t = useTranslations();

  return (
    <Upload
      multiple
      showUploadList={false}
      // The request is ours: antd would otherwise post multipart to an endpoint that takes the file
      // as the body itself.
      beforeUpload={(file: RcFile) => {
        onFiles(file);
        return Upload.LIST_IGNORE;
      }}
    >
      <Button icon={<UploadOutlined />}>{t('documents.upload.action')}</Button>
    </Upload>
  );
}

// Wraps the grid so a file can be dropped anywhere on it, without the drop zone drawing a box around
// everything when nothing is being dragged.
export function UploadDropZone({
  onFiles,
  children,
}: {
  onFiles: (file: File) => void;
  children: ReactNode;
}) {
  const t = useTranslations();

  return (
    <Upload.Dragger
      multiple
      openFileDialogOnClick={false}
      showUploadList={false}
      beforeUpload={(file: RcFile) => {
        onFiles(file);
        return Upload.LIST_IGNORE;
      }}
      style={{ background: 'transparent', border: 'none', padding: 0 }}
    >
      <div style={{ textAlign: 'start', cursor: 'default' }}>{children}</div>
      <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}>
        <InboxOutlined />
      </p>
      <p className="ant-upload-hint">{t('documents.upload.hint')}</p>
    </Upload.Dragger>
  );
}
