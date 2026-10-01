'use client';

import { Alert, Button, Empty, Space, Spin, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { type DocumentDetailDto } from '../../../../shared/contracts/documents';

// The re-read is an operation, so it travels as one: a pane drawn for somebody who may not act on
// the document is given neither the handler nor the flag, and the offer is not made (docs/11 §11.5e).
export function TextPane({
  document,
  markdown,
  loading,
  onReadAgain,
  readingAgain = false,
  isAdmin,
}: {
  document: DocumentDetailDto;
  markdown: string | null;
  loading: boolean;
  onReadAgain?: () => void;
  readingAgain?: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations();
  // The verdict the analysis returned about this very text (docs/03 §3.3.10). It was written down
  // and read by nobody, which made it a fact the archive knew and never said.
  const quality = document.auto.textQuality;
  // And the same judgement counted, where the analysis gave one: "some of this document was not
  // read" is a different sentence at 81 out of 100 than at 12, and the reader weighing up the
  // re-read is who that difference is for. 🔒 It decides nothing about whether the warning appears
  // — the three-word verdict above does that, as it always did (docs/11 §11.5).
  const extraction = document.auto.quality?.extraction;
  // 🔒 Only the two verdicts that are drawn are put into words. `GOOD` is the third value the
  // analysis can return (docs/03 §3.3.10) and nothing renders it — a document read properly says
  // nothing about having been read properly — so asking the catalogue for it was a missing-message
  // error on every well-read document, and translating it would have been a message no screen
  // shows. The condition that decides the sentence is the one that decides the warning.
  const warn = quality === 'PARTIAL' || quality === 'NONE';
  const verdict = !warn
    ? ''
    : extraction === undefined
      ? t(`viewer.textQuality.${quality}`)
      : `${t(`viewer.textQuality.${quality}`)} — ${t('viewer.textQuality.mark', { value: extraction })}`;

  if (loading) return <Spin />;

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {/* 🔒 Above the text and above the *absence* of it. A document whose recognition returned
          nothing is the case this warning exists for, and it is exactly the case with no text to
          stand under: drawn after the empty state, it would never appear on the one document that
          needs it most (docs/11 §11.5). */}
      {warn && (
        <Alert
          type="warning"
          showIcon
          title={verdict}
          description={t('viewer.textQuality.explained')}
          {...(isAdmin && onReadAgain !== undefined
            ? {
                action: (
                  <Button size="small" onClick={onReadAgain} loading={readingAgain}>
                    {t('viewer.textQuality.readAgain')}
                  </Button>
                ),
              }
            : {})}
        />
      )}
      {markdown === null || markdown === '' ? (
        <Empty
          description={
            document.steps.markdown === 'FAILED'
              ? t('viewer.textFailed')
              : document.steps.markdown === 'RUNNING' ||
                  document.steps.markdown === 'PENDING' ||
                  document.steps.markdown === 'QUEUED'
                ? t('viewer.textPending')
                : t('viewer.noText')
          }
        />
      ) : (
        <RenderedMarkdown markdown={markdown} />
      )}
    </Space>
  );
}

// 🔒 Extracted text is untrusted content: raw HTML never passes through (docs/10 §10.8).
//
// Typeset rather than merely rendered (docs/11 §11.5): the rhythm, the tables and the code all come
// from `.legere-prose`, so this stays a document being read rather than a browser's idea of one.
function RenderedMarkdown({ markdown }: { markdown: string }) {
  return (
    <Typography className="legere-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          // A table gets a scroller of its own: a fourteen-column invoice must not widen the pane,
          // and the columns must not be squeezed into it either.
          table: ({ node: _node, ...props }) => (
            <div className="legere-prose-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </Typography>
  );
}
