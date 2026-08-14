'use client';

import { InboxOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Typography, Upload, theme } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// The two ways of choosing files (docs/11 §11.3): a button in the header, and the whole screen as a
// drop zone. Neither of them sends anything — what happens to a chosen file is the upload queue's
// business, and it is watched in the panel rather than here (docs/11 §11.3a).

// A hint for the picker, not the gate: the server refuses what it cannot render (docs/05 §5.1a),
// and a drop cannot be filtered at all. Mirrors the formats of docs/05 §5.5.
const ACCEPTED_FORMATS =
  'application/pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.epub,.html,.htm,.txt,.md,.markdown,.csv,.json,.xml,.log';

export function UploadButton({
  onFiles,
  label,
}: {
  onFiles: (file: File) => void;
  label?: string;
}) {
  const t = useTranslations();

  return (
    <Upload
      multiple
      accept={ACCEPTED_FORMATS}
      showUploadList={false}
      // The request is ours: antd would otherwise post multipart to an endpoint that takes the file
      // as the body itself.
      beforeUpload={(file: RcFile) => {
        onFiles(file);
        return Upload.LIST_IGNORE;
      }}
    >
      <Button icon={<UploadOutlined />}>{label ?? t('documents.upload.action')}</Button>
    </Upload>
  );
}

// What a drag is carrying, decided at `dragover` time. The file list itself is unreadable until the
// drop — the browser hides the payload of a drag in progress — so `types` is the only evidence
// available, and anything dragged in from outside the page is announced there as `Files`. Dragged
// text, a link or a selection says so here and is left entirely alone: an overlay promising an
// upload that cannot happen is worse than no overlay, and taking the default away from such a drag
// would break dropping text into an input.
function carriesFiles(transfer: DataTransfer | null): transfer is DataTransfer {
  return transfer !== null && Array.from(transfer.types).includes('Files');
}

// The whole screen is the drop zone (docs/11 §11.3). The listeners are on the window rather than on
// a box around the grid, so a file dropped on the heading, on the filter bar or on the empty space
// beside the cards lands exactly like one dropped on a card — and the browser's own default for a
// file dropped on a page, which is to navigate away to it, is taken away wherever it would fire.
export function UploadDropZone({
  onFiles,
  children,
}: {
  onFiles: (file: File) => void;
  children: ReactNode;
}) {
  const t = useTranslations();
  const { token } = theme.useToken();
  const [dragging, setDragging] = useState(false);

  // Enter and leave are counted in pairs rather than believed one at a time. `dragleave` fires on an
  // element the moment the pointer crosses into one of its own children, so a handler that lowers
  // the overlay on the first leave lowers it in the middle of a drag and raises it again in the next
  // frame — the flicker. Every `dragenter` has exactly one `dragleave`, so while the count is above
  // zero the drag is still somewhere over the page, whatever the tree under the pointer looks like.
  // The other cure — ignoring a leave whose `relatedTarget` is inside the zone — has to reason about
  // a target that is `null` both when the pointer leaves the window (clear) and when it crosses into
  // some browsers' shadow content (do not clear); the counter needs no such special case.
  const depth = useRef(0);

  useEffect(() => {
    const clear = () => {
      depth.current = 0;
      setDragging(false);
    };

    const enter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current += 1;
      setDragging(true);
    };

    const over = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      // Without this the drop never happens: the browser reads an un-prevented `dragover` as "this
      // is not a drop target" and falls back to opening the file in the tab.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const leave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      // Never below zero: a drag that began before this screen mounted would otherwise leave a debt
      // that the next one has to pay off before anything appears.
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };

    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      clear();
      for (const file of files) onFiles(file);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    // A drag abandoned with Escape ends without a leave in some browsers; this is the one event that
    // is always there to say it is over.
    window.addEventListener('dragend', clear);

    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', clear);
    };
  }, [onFiles]);

  return (
    <>
      {children}
      {dragging && (
        // Over everything and taking nothing: the drag has to keep reaching the page underneath, and
        // a surface that swallowed the pointer would end the drag it is announcing.
        <div
          style={{
            position: 'fixed',
            inset: 8,
            zIndex: 1000,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: token.borderRadiusLG,
            border: `2px dashed ${token.colorPrimary}`,
            background: token.colorBgMask,
          }}
        >
          <div
            style={{
              padding: '24px 32px',
              borderRadius: token.borderRadiusLG,
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              textAlign: 'center',
            }}
          >
            <InboxOutlined
              style={{ fontSize: 40, color: token.colorPrimary, display: 'block' }}
              aria-hidden
            />
            <Typography.Text style={{ display: 'block', marginTop: 8 }}>
              {t('documents.upload.hint')}
            </Typography.Text>
          </div>
        </div>
      )}
    </>
  );
}
