'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileTextOutlined } from '@ant-design/icons';
import { App, Button, Col, Collapse, List, Row, Space, Tag, Typography, Upload, theme } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  type DocumentDetailDto,
  type DocumentFileDto,
  type DocumentFileVersionDto,
} from '../../../../shared/contracts/documents';
import { documentApi, documentFiles, documentKeys } from '../../../entities/document';
import { UploadButton } from '../../../features/document-upload';
import { PageStrip } from '../../../features/document-pages';
import { useUploadQueue } from '../../../features/upload-queue';
import { useErrorMessage, formatBytes } from '../../../shared/lib';
import { DownloadSplitButton } from './preview-pane';
import { DeleteSection } from './delete-section';

// A document is an ordered list of **pages** (docs/03 §3.3.17, ADR-025), and this is where that list
// is visible and worked on (docs/11 §11.5a). A tab of its own rather than the last section of
// Details: what a document is made of is a different question from what it is about, and it is the
// one thing here that is worked on rather than read — under the metadata it sat below a form nobody
// had opened and a table of step costs nobody had asked for. Every action rebuilds the document —
// the canonical PDF, the preview, the text, the analysis — so the pane says so once, quietly, and
// then stays usable while it happens.
//
// **The pages lead and the files follow.** The strip is what somebody came to arrange; the rows
// under it are where the bytes came from, and they keep only what is genuinely about a file —
// download, replace, the path, the storage key. The crop, the turn, the order, the cut and the move
// all live on the page they act on, because a control aimed at a page that nothing draws is a
// control nobody can point (docs/11 §11.5a).
//
// It is also where the document as a whole is handed over and where it is destroyed (docs/11 §11.5b,
// §11.5d): "the document as one piece", "one of the originals" and "these are the originals" are
// three answers to one question, and the dropdown of the first is a list of exactly the rows below
// it. Download stands at the top, Delete at the foot with the whole list between them.
//
// 🔒 `readOnly` leaves the pages and the rows and takes the work away (docs/11 §11.5e): the strip,
// the whereabouts, the earlier versions and every download stay, because that is what reading a
// document's composition means; adding, replacing, cropping, arranging, cutting, moving and deleting
// do not, because a peek is a look at somebody else's document.
export function FilesPane({
  document,
  isAdmin,
  readOnly = false,
}: {
  document: DocumentDetailDto;
  isAdmin: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  // The application's one queue, pointed at this document: files land here in the order chosen, and
  // they are watched in the upload panel like every other upload (docs/11 §11.3a, §11.5a).
  const { send } = useUploadQueue();
  // Which row is having its bytes replaced. The upload happens in place of a file rather than at the
  // end of the list, so the row it lands on is the only honest place to show it going (docs/11
  // §11.5a) — a queued card above the list would be about a file that is not arriving.
  const [replacing, setReplacing] = useState<string | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(document.id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(document.id) });
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  // A page re-photographed is still that page: the new scan takes the old one's positions and the
  // page order does not move (docs/05 §5.6). The scan it displaces goes to the trash under this same
  // row, which is what makes replacing something a person can take back (docs/05 §5.7a).
  const replace = useMutation({
    mutationFn: ({ fileId, file }: { fileId: string; file: File }) =>
      documentApi.replaceFile(document.id, fileId, file),
    onMutate: ({ fileId }) => {
      setReplacing(fileId);
    },
    onSuccess: () => {
      void message.success(t('viewer.files.replaced'), 3);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
    onSettled: () => setReplacing(null),
  });

  // A file dropped — or chosen — at a seam of the strip goes **there** (docs/11 §11.5a, §11.3a). The
  // page it goes before travels with it, so the second file of a batch is measured against the list
  // the first one produced rather than against the list that was on the screen.
  //
  // 🔒 At the **last** seam there is no page to go before, and the position is therefore not sent at
  // all: the two travel together or neither does. An explicit `at` with nothing to re-measure it
  // against is the same number on every file of the batch — each one landing ahead of the last, so
  // three files dropped at the end arrive `c, b, a`. Left off, the request is the append the server
  // computes inside its own transaction, which is also the only answer that stays right when
  // somebody else is adding pages at the same time.
  const insertAt = (files: File[], at: number): void => {
    const ordered = [...document.pages].sort((a, b) => a.position - b.position);
    const before = ordered[at]?.id;
    send(
      files,
      before === undefined
        ? { documentId: document.id }
        : { documentId: document.id, at, beforePageId: before },
    );
  };

  const busy = replace.isPending;

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {/* The two things that can be done with the document as a whole, and then — under both — the
          price of touching anything below (docs/11 §11.5a). No heading of its own: the tab is
          called Files, and a title under its own label is the same word twice. */}
      <Row align="middle" justify="space-between" gutter={[8, 8]}>
        <Col>
          <DownloadSplitButton document={document} />
        </Col>
        {!readOnly && (
          <Col>
            <UploadButton
              onFiles={(file) => send([file], { documentId: document.id })}
              label={t('viewer.files.add')}
            />
          </Col>
        )}
      </Row>

      {/* The price of touching anything below, said once — and not said at all where nothing below
          can be touched (docs/11 §11.5e). */}
      {!readOnly && (
        <Typography.Text type="secondary">{t('viewer.files.rebuildNote')}</Typography.Text>
      )}

      {/* The document itself, in order: every page of every file, and everything that can be done to
          one of them (docs/11 §11.5a). */}
      <PageStrip document={document} onInsertFiles={insertAt} readOnly={readOnly} />

      {/* And where the bytes came from. Real files only: a row appears when its file has landed and
          the list is refetched, never before — what is on its way is watched in the panel. */}
      <Typography.Text strong>{t('viewer.files.heading')}</Typography.Text>
      <List
        className="legere-file-list"
        dataSource={document.files}
        rowKey="id"
        size="small"
        renderItem={(file: DocumentFileDto) => (
          <List.Item
            actions={[
              <Button
                key="download"
                size="small"
                type="link"
                disabled={!file.available}
                download={file.name}
                {...(file.available
                  ? { href: documentFiles.fileContent(document.id, file.id) }
                  : {})}
              >
                {t('viewer.files.download')}
              </Button>,
              // Everything from here on acts on the document, so a pane that is only being
              // looked at carries none of it (docs/11 §11.5e).
              ...(readOnly
                ? []
                : [
                    // The picker opens on the row the new scan is for, and one file at a time: a page is
                    // replaced by a page (docs/11 §11.5a). The request is ours for the reason the upload
                    // button gives — the endpoint takes the file as the body itself.
                    <Upload
                      key="replace"
                      showUploadList={false}
                      disabled={busy}
                      beforeUpload={(chosen) => {
                        replace.mutate({ fileId: file.id, file: chosen });
                        return Upload.LIST_IGNORE;
                      }}
                    >
                      <Button
                        size="small"
                        type="link"
                        disabled={busy}
                        loading={replacing === file.id}
                      >
                        {t('viewer.files.replace')}
                      </Button>
                    </Upload>,
                  ]),
            ]}
          >
            <List.Item.Meta
              avatar={
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
                  {file.isImage && file.available ? (
                    // An API route that 302s to a signed URL, or streams the volume's own bytes
                    // (docs/10 §10.8).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={documentFiles.fileContent(document.id, file.id)}
                      alt=""
                      loading="lazy"
                      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                    />
                  ) : (
                    <FileTextOutlined
                      style={{ fontSize: 20, color: token.colorTextQuaternary }}
                      aria-hidden
                    />
                  )}
                </div>
              }
              title={
                <Space size={4} wrap>
                  <span>{file.name}</span>
                  {/* The one tag that is about the **file**: these bytes cannot be read right now.
                      Cropped, Rearranged and Turned were about how pages read, and pages have a
                      strip of their own that draws every one of them (docs/11 §11.5a). */}
                  {!file.available && <Tag color="default">{t('viewer.files.missing')}</Tag>}
                </Space>
              }
              description={
                <Space direction="vertical" size={0}>
                  {/* What it is and what it weighs. The kind is the mime type rather than the
                      extension: the name above already ends in `.jpg`. */}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {`${file.mimeType} · ${formatBytes(file.sizeBytes)}`}
                  </Typography.Text>
                  {/* Where the bytes live is a fact about the file, and it belongs beside the file
                      rather than in a section of its own (docs/11 §11.5a). */}
                  {file.refs.map((ref) => (
                    <Typography.Text
                      key={`${ref.libraryId}:${ref.path}`}
                      type="secondary"
                      style={{ fontSize: 12 }}
                      code
                    >
                      {`${ref.libraryName}: ${ref.path}`}
                    </Typography.Text>
                  ))}
                  {/* The same answer for a file that lies on no volume: the object storage, named as
                      such, and the key the bytes are under (docs/09 §9.2). A managed file used to say
                      nothing at all here, which made an uploaded document look like one with no
                      whereabouts.
                      🔒 Text, never a link: the key is a location and grants nothing on its own —
                      the bucket is private and only a signed URL reads it. */}
                  {file.storageKey !== null && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} code>
                      {`${t('viewer.files.objectStorage')}: ${file.storageKey}`}
                    </Typography.Text>
                  )}
                  {file.earlierVersions.length > 0 && (
                    <EarlierVersions documentId={document.id} versions={file.earlierVersions} />
                  )}
                </Space>
              }
            />
          </List.Item>
        )}
      />

      {/* Last in the tab, below everything the document can still be used for (docs/11 §11.5d).
          Never in a peek: the one control that destroys anything belongs on the screen of the
          document it destroys (docs/11 §11.5e). */}
      {isAdmin && !readOnly && <DeleteSection document={document} />}
    </Space>
  );
}

// The copies a page has had, under the page that replaced them (docs/11 §11.5a). Collapsed, because
// what belongs to the document is the row above and these are the answer to a question asked rarely
// — "what did this page look like before" — which is the whole reason the old scan was kept rather
// than destroyed (docs/05 §5.6). They are in the trash, so each says where it is going: a file of
// ours names the day the sweep takes it, and a library original says it is on the volume, which no
// sweep will ever touch (docs/05 §5.7a). Getting one back into a document is the trash screen's
// business and makes a new document, so nothing here pretends to be an undo of the page order.
function EarlierVersions({
  documentId,
  versions,
}: {
  documentId: string;
  versions: DocumentFileVersionDto[];
}) {
  const t = useTranslations();

  return (
    <Collapse
      ghost
      size="small"
      items={[
        {
          key: 'versions',
          label: t('viewer.files.versions', { count: versions.length }),
          children: (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {versions.map((version) => (
                <Space key={version.id} direction="vertical" size={0}>
                  <Space size={4} wrap>
                    <span>{version.name}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {`${formatBytes(version.sizeBytes)} · ${t('viewer.files.versionReplaced', {
                        date: new Date(version.trashedAt).toLocaleString(),
                      })}`}
                    </Typography.Text>
                    {/* The old scan is still readable, which is what it was kept for — down the
                        same route as the file above it, by its own id (docs/07 §7.3). */}
                    <Button
                      size="small"
                      type="link"
                      disabled={!version.available}
                      download={version.name}
                      {...(version.available
                        ? { href: documentFiles.fileContent(documentId, version.id) }
                        : {})}
                    >
                      {t('viewer.files.download')}
                    </Button>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {version.purgeAfter === null
                      ? t('viewer.files.versionOnVolume')
                      : t('viewer.files.versionGoes', {
                          date: new Date(version.purgeAfter).toLocaleString(),
                        })}
                  </Typography.Text>
                </Space>
              ))}
            </Space>
          ),
        },
      ]}
    />
  );
}
