'use client';

import { DownOutlined, FileTextOutlined } from '@ant-design/icons';
import { Button, Dropdown, Empty, Space, Tooltip, Typography, theme } from 'antd';
import { useTranslations } from 'next-intl';
import {
  type DocumentDetailDto,
  type DocumentListDto,
} from '../../../../shared/contracts/documents';
import { documentFiles, DocumentImage } from '../../../entities/document';

// The document itself, as the browser can show it (docs/10 §10.8): **the canonical PDF**, whatever
// the document happens to be made of — by the time it is readable it is a PDF (docs/05 §5.5). Until
// that step has finished there is nothing whole to show, so the pane is honest about it rather than
// quietly showing page one of forty (docs/11 §11.5).
export function PreviewPane({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();

  if (document.steps.canonical === 'DONE') {
    return (
      <object
        // Keyed by the step that produces it: a canonical requested before it existed is a dead
        // embed the browser will never retry on its own (docs/10 §10.5).
        key={document.steps.canonical}
        data={documentFiles.canonical(document.id)}
        type="application/pdf"
        // The height is the pane's, not a slice of the window guessed at in advance: where the two
        // panes stand side by side the document reaches the foot of the screen, and where the layout
        // is one column it falls back to a fixed share of it (docs/11 §11.5).
        className="legere-viewer-preview"
        aria-label={t('viewer.tabs.preview')}
      >
        {/* Whatever the browser cannot render inline, it can still download. */}
        <a href={documentFiles.canonical(document.id, { download: true })}>
          {t('viewer.download')}
        </a>
      </object>
    );
  }

  // The chosen preview page, while the whole document is still being put together — saying that is
  // what this is, so nobody reads a one-page preview as the whole document.
  if (document.hasPreview) {
    return (
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('viewer.canonical.assembling')}</Typography.Text>
        <DocumentImage
          key={document.steps.preview}
          src={documentFiles.preview(document.id, document.previewRevision)}
          alt={document.title}
          style={{ maxWidth: '100%' }}
        />
      </Space>
    );
  }

  return (
    <Empty
      description={
        document.steps.canonical === 'FAILED'
          ? t('viewer.canonical.failed')
          : t('viewer.canonical.assembling')
      }
    />
  );
}

// The other document's chosen preview page, at the size of a row (docs/11 §11.5e) — what the sidebar card
// never had the width for, and the fastest answer to "which act was that". The same fallback the
// file rows use: an artifact can be missing even where the step says it was made.
export function DocumentThumb({ document }: { document: DocumentListDto }) {
  const { token } = theme.useToken();

  return (
    <div
      style={{
        width: 44,
        height: 56,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--legere-well)',
        overflow: 'hidden',
      }}
    >
      {document.hasPreview ? (
        <DocumentImage
          src={documentFiles.thumb(document.id, document.previewRevision)}
          alt=""
          width={44}
          height={56}
          loading="lazy"
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      ) : (
        <FileTextOutlined style={{ fontSize: 20, color: token.colorTextQuaternary }} aria-hidden />
      )}
    </div>
  );
}

export function DownloadSplitButton({ document }: { document: DocumentDetailDto }) {
  const t = useTranslations();
  const ready = document.steps.canonical === 'DONE';

  return (
    <Space.Compact>
      <Tooltip title={ready ? undefined : t('viewer.canonical.assembling')}>
        {/* antd drops the href of a disabled button, so there is nothing left to click through to
            while the document is not one piece yet (docs/11 §11.5b). */}
        <Button
          type="primary"
          disabled={!ready}
          {...(ready ? { href: documentFiles.canonical(document.id, { download: true }) } : {})}
        >
          {t('viewer.download')}
        </Button>
      </Tooltip>
      {/* Enabled even while the canonical is not: the dropdown is the answer to "I need the raw
          file", and it has to work on the worst day (docs/11 §11.5b). */}
      <Dropdown
        trigger={['click']}
        menu={{
          items: document.files.map((file) => ({
            key: file.id,
            disabled: !file.available,
            label: file.available ? (
              <a href={documentFiles.fileContent(document.id, file.id)} download={file.name}>
                {file.name}
              </a>
            ) : (
              <Space size={4}>
                <span>{file.name}</span>
                <Typography.Text type="secondary">
                  {t('viewer.files.missingReason')}
                </Typography.Text>
              </Space>
            ),
          })),
        }}
      >
        <Button type="primary" aria-label={t('viewer.downloadOriginals')} icon={<DownOutlined />} />
      </Dropdown>
    </Space.Compact>
  );
}
