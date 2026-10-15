'use client';

/* eslint-disable @eslint-react/no-array-index-key -- CMS signer positions are immutable; a certificate may appear more than once. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Collapse,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { SafetyCertificateOutlined, UploadOutlined } from '@ant-design/icons';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { DocumentDetailDto } from '../../../../shared/contracts/documents';
import type { FileSignatureDto, SignatureSigner } from '../../../../shared/contracts/signatures';
import { documentSignatureApi, signatureKey } from '../../../entities/document';
import { useCurrentUser } from '../../../entities/user';
import { useErrorMessage } from '../../../shared/lib';
import { QueryError } from '../../../shared/ui';

function useSignatures(document: DocumentDetailDto) {
  return useQuery({
    queryKey: signatureKey(document),
    queryFn: () => documentSignatureApi.list(document.id),
    staleTime: 60_000,
  });
}

export function SignatureBadge({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations('viewer.signatures');
  const query = useSignatures(document);
  const signatures = query.data?.files.flatMap((file) => file.signatures) ?? [];
  if (signatures.length === 0) return null;
  const valid = signatures.every(
    (signature) =>
      signature.report.signers.every((signer) => signer.verification === 'VALID') &&
      signature.report.coversWholeFile !== false,
  );
  return (
    <Link href={`/documents/${document.id}/files`}>
      <Tag
        icon={<SafetyCertificateOutlined />}
        color={valid ? 'blue' : 'orange'}
        style={{ marginTop: 12, whiteSpace: 'normal' }}
      >
        {t('badge', { count: signatures.length })}
      </Tag>
    </Link>
  );
}

export function SignaturesSection({
  document,
  isAdmin,
  readOnly = false,
}: {
  document: DocumentDetailDto;
  isAdmin: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations('viewer.signatures');
  const query = useSignatures(document);
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const { message } = App.useApp();
  const describeError = useErrorMessage();
  const [selected, setSelected] = useState<string | undefined>();
  const fileId =
    selected !== undefined && document.files.some((file) => file.id === selected)
      ? selected
      : document.files[0]?.id;
  const canAttach =
    !readOnly && (isAdmin || document.origin === 'LIBRARY' || document.createdBy?.id === user.id);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['document-signatures', document.id] });
  const attach = useMutation({
    mutationFn: ({ originalId, file }: { originalId: string; file: File }) =>
      documentSignatureApi.attach(document.id, originalId, file),
    onSuccess: () => {
      void refresh();
      void message.success(t('attached'));
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });
  const remove = useMutation({
    mutationFn: ({ originalId, signatureId }: { originalId: string; signatureId: string }) =>
      documentSignatureApi.remove(document.id, originalId, signatureId),
    onSuccess: () => {
      void refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });
  return (
    <section aria-label={t('heading')} style={{ width: '100%', marginTop: 16 }}>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('heading')}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('scope')}
        </Typography.Paragraph>
        {canAttach && (
          <Space wrap>
            {document.files.length > 1 && (
              <Select
                aria-label={t('original')}
                value={fileId}
                onChange={setSelected}
                style={{ minWidth: 200, maxWidth: '100%' }}
                options={document.files.map((file) => ({ value: file.id, label: file.name }))}
              />
            )}
            <Upload
              accept=".sig,.p7s,.p7b,.pem"
              showUploadList={false}
              disabled={attach.isPending || fileId === undefined}
              beforeUpload={(file) => {
                if (fileId !== undefined) attach.mutate({ originalId: fileId, file });
                return Upload.LIST_IGNORE;
              }}
            >
              <Button
                icon={<UploadOutlined />}
                loading={attach.isPending}
                disabled={fileId === undefined}
              >
                {t('attach')}
              </Button>
            </Upload>
          </Space>
        )}
        {query.isPending && <Spin size="small" aria-label={t('checking')} />}
        {query.isError && <QueryError error={query.error} retry={query.refetch} />}
        {query.data?.files.map((file) => (
          <div key={file.fileId} style={{ width: '100%', minWidth: 0 }}>
            <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>
              {file.fileName}
            </Typography.Text>
            {file.discovery !== 'COMPLETE' && (
              <Space wrap>
                <Typography.Text type="secondary">
                  {t(`discovery.${file.discovery}`)}
                </Typography.Text>
                {file.discovery === 'ERROR' && (
                  <Button size="small" type="link" onClick={() => void query.refetch()}>
                    {t('retry')}
                  </Button>
                )}
              </Space>
            )}
            {file.discovery === 'COMPLETE' && file.signatures.length === 0 && (
              <Typography.Paragraph type="secondary">{t('unsigned')}</Typography.Paragraph>
            )}
            {file.signatures.length > 0 && (
              <Collapse
                size="small"
                style={{ marginTop: 8 }}
                items={file.signatures.map((signature, index) => ({
                  key: signature.id ?? `embedded-${index}`,
                  label: (
                    <Space wrap>
                      <span style={{ overflowWrap: 'anywhere' }}>
                        {signature.source === 'EMBEDDED'
                          ? t('embedded', { number: index + 1 })
                          : signature.name}
                      </span>
                      {signature.report.signers.map((signer, i) => (
                        <VerificationTag key={i} signer={signer} />
                      ))}
                      {signature.report.coversWholeFile === false && (
                        <Tag color="orange">{t('earlierRevision')}</Tag>
                      )}
                    </Space>
                  ),
                  children: (
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      {signature.report.coversWholeFile === false && (
                        <Alert type="warning" showIcon title={t('changedAfterSigning')} />
                      )}
                      <Typography.Text type="secondary">
                        {t('checkedAt', {
                          date: new Date(signature.report.checkedAt).toLocaleString(),
                        })}
                      </Typography.Text>
                      {signature.report.signers.map((signer, i) => (
                        <SignerDetails key={i} signer={signer} />
                      ))}
                      <HashDetail label={t('originalHash')} value={file.originalHash} />
                      <HashDetail label={t('signatureHash')} value={signature.contentHash} />
                      <SignatureActions
                        signature={signature}
                        documentId={document.id}
                        fileId={file.fileId}
                        canRemove={isAdmin && !readOnly}
                        removing={remove.isPending}
                        onRemove={(signatureId) =>
                          remove.mutate({ originalId: file.fileId, signatureId })
                        }
                      />
                    </Space>
                  ),
                }))}
              />
            )}
          </div>
        ))}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('trustNote')}
        </Typography.Paragraph>
      </Space>
    </section>
  );
}

function VerificationTag({ signer }: { signer: SignatureSigner }) {
  const t = useTranslations('viewer.signatures');
  return (
    <Tag
      style={{ whiteSpace: 'normal', maxWidth: '100%' }}
      color={
        signer.verification === 'VALID'
          ? 'blue'
          : signer.verification === 'INVALID'
            ? 'red'
            : 'orange'
      }
    >
      {t(`verification.${signer.verification}`)}
    </Tag>
  );
}

function HashDetail({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <div style={{ minWidth: 0, width: '100%' }}>
      <Typography.Text type="secondary">{label}: </Typography.Text>
      <Typography.Text copyable code style={{ overflowWrap: 'anywhere' }}>
        {value}
      </Typography.Text>
    </div>
  );
}

function SignerDetails({ signer }: { signer: SignatureSigner }) {
  const t = useTranslations('viewer.signatures');
  const [now] = useState(Date.now);
  const inDate =
    signer.validFrom !== null &&
    signer.validTo !== null &&
    Date.parse(signer.validFrom) <= now &&
    now <= Date.parse(signer.validTo);
  return (
    <Space orientation="vertical" size={4} style={{ width: '100%', overflowWrap: 'anywhere' }}>
      <Typography.Text strong>{signer.subject ?? t('unknownSigner')}</Typography.Text>
      {signer.issuer !== null && (
        <Typography.Text>
          {t('issuer')}: {signer.issuer}
        </Typography.Text>
      )}
      <HashDetail label={t('serial')} value={signer.serialNumber} />
      <HashDetail label={t('fingerprint')} value={signer.certificateSha256} />
      {signer.validFrom !== null && signer.validTo !== null && (
        <Typography.Text type={inDate ? 'secondary' : 'warning'}>
          {t('validity', {
            from: new Date(signer.validFrom).toLocaleDateString(),
            to: new Date(signer.validTo).toLocaleDateString(),
          })}
          {!inDate && ` · ${t('outsideValidity')}`}
        </Typography.Text>
      )}
      {signer.signingTime !== null && (
        <Typography.Text>
          {t('signingTime')}: {new Date(signer.signingTime).toLocaleString()}
        </Typography.Text>
      )}
      <Typography.Text>
        {t('digestAlgorithm')}: {signer.digestAlgorithm}
      </Typography.Text>
      <Typography.Text>
        {t('signatureAlgorithm')}: {signer.signatureAlgorithm}
      </Typography.Text>
      {signer.digestMatch !== null && (
        <Typography.Text>
          {t(signer.digestMatch ? 'digestMatches' : 'digestMismatch')}
        </Typography.Text>
      )}
    </Space>
  );
}

function SignatureActions({
  signature,
  documentId,
  fileId,
  canRemove,
  removing,
  onRemove,
}: {
  signature: FileSignatureDto;
  documentId: string;
  fileId: string;
  canRemove: boolean;
  removing: boolean;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations('viewer.signatures');
  const id = signature.id;
  if (id === null) return null;
  return (
    <Space wrap>
      <Button size="small" href={documentSignatureApi.content(documentId, fileId, id)}>
        {t('download')}
      </Button>
      {canRemove && (
        <Popconfirm title={t('removeConfirm')} onConfirm={() => onRemove(id)}>
          <Button danger size="small" loading={removing}>
            {t('remove')}
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
}
