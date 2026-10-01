'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Select,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import { QueryError } from '../../shared/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { documentTypeApi, documentTypeKeys } from '../../entities/document-type';
import { collectionApi, collectionKeys } from '../../entities/collection';
import { documentApi, documentFiles, documentKeys, DocumentImage } from '../../entities/document';
import { receiptApi, receiptKeys } from '../../entities/receipt';
import { personApi, personKeys } from '../../entities/person';
import { subjectApi, subjectKeys } from '../../entities/subject';
import { subjectKindApi, subjectKindKeys } from '../../entities/subject-kind';
import { useIsAdmin } from '../../entities/user';
import { useErrorMessage } from '../../shared/lib';
import { isViewerTab, type ViewerTab } from '../../entities/document';
import { LIVE_REFRESH_MS } from './model/events';
import { type MetaChange } from './model/details';
import { PreviewPane } from './ui/preview-pane';
import { TextPane } from './ui/text-pane';
import { RelatedPane } from './ui/related-pane';
import { LogPane } from './ui/log-pane';
import { DetailsPane } from './ui/details-pane';
import { FilesPane } from './ui/files-pane';

// /documents/:id (docs/11 §11.5): read the document, and manage the little that belongs to it.
export function DocumentViewer({ id, tab = 'preview' }: { id: string; tab?: ViewerTab }) {
  const t = useTranslations();
  // The role decides which of these controls are drawn at all; the API refuses them regardless, so
  // this is presentation. It comes from the layout that already asked who is signed in, which is
  // what lets this segment — rewritten on every tab press — await nothing (docs/10 §10.2).
  const isAdmin = useIsAdmin();
  const router = useRouter();
  // The address is the source of truth, but the tab switches on the click rather than after the
  // navigation: a tab that waits for the router to come back feels broken.
  const [pendingTab, setPendingTab] = useState<{
    documentId: string;
    from: ViewerTab;
    to: ViewerTab;
  } | null>(null);
  const active = pendingTab?.documentId === id && pendingTab.from === tab ? pendingTab.to : tab;
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message, modal } = App.useApp();

  const document = useQuery({
    queryKey: documentKeys.detail(id),
    queryFn: () => documentApi.get(id),
    refetchInterval: (query) => (query.state.data?.processing === true ? LIVE_REFRESH_MS : false),
  });

  const markdown = useQuery({
    queryKey: documentKeys.markdown(id),
    queryFn: () => documentApi.markdown(id),
    enabled: document.data !== undefined,
  });

  // The document itself is polled while the pipeline works on it, so Details keeps up on its own.
  // The text and the log live on their own queries and would sit there stale, showing "being
  // extracted" over a document that finished a minute ago (docs/10 §10.5). Rather than polling them
  // too, they are refetched when a step changes state: that is the only moment either can change,
  // and it is already being watched.
  const stepsKey = JSON.stringify(document.data?.steps ?? {});
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(id) });
    // Existing catalogue matches can be linked by analysis (05 §5.5), so a list fetched when the
    // screen mounted may not yet reflect which labels the document now uses. Novel model answers
    // remain proposals and create nothing until the viewer's explicit Add action (SEC-11).
    void queryClient.invalidateQueries({ queryKey: personKeys.all });
    void queryClient.invalidateQueries({ queryKey: subjectKeys.all });
  }, [stepsKey, id, queryClient]);

  const documentTypes = useQuery({ queryKey: documentTypeKeys.all, queryFn: documentTypeApi.list });
  const collections = useQuery({ queryKey: collectionKeys.all, queryFn: collectionApi.list });
  const people = useQuery({ queryKey: personKeys.all, queryFn: () => personApi.list() });
  const subjects = useQuery({ queryKey: subjectKeys.all, queryFn: () => subjectApi.list() });
  const subjectKinds = useQuery({
    queryKey: subjectKindKeys.all,
    queryFn: () => subjectKindApi.list(),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(id) });
  };

  const update = useMutation({
    mutationFn: (input: MetaChange) => documentApi.update(id, input),
    onSuccess: () => {
      void message.success(t('viewer.saved'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const addToCollection = useMutation({
    mutationFn: (collectionId: string) => collectionApi.addItem(collectionId, id),
    onSuccess: () => {
      void message.success(t('viewer.addedToCollection'), 2);
      void queryClient.invalidateQueries({ queryKey: collectionKeys.all });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // Reading the document again, from the pages up: the recogniser of last resort runs in step 3,
  // and everything downstream of it is read off what that step wrote (docs/05 §5.5).
  const readAgain = useMutation({
    mutationFn: () => documentApi.reprocess(id, { steps: ['markdown', 'analysis'] }),
    onSuccess: () => {
      void message.success(t('viewer.processing.queued'), 2);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const moveToReceipts = useMutation({
    mutationFn: () => receiptApi.convert(id, 'RECEIPT'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: receiptKeys.all });
      router.replace(`/receipts/${id}`);
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  if (document.isPending) return <Spin />;
  if (document.isError && document.data === undefined)
    return <QueryError error={document.error} retry={document.refetch} />;
  if (document.data === undefined) return <Empty description={t('errors.codes.NOT_FOUND')} />;

  const detail = document.data;

  return (
    <>
      {document.isError && <QueryError error={document.error} retry={document.refetch} />}
      {/*
        The two panes, and the height the window has: the classes are where the flex chain down to
        the document is hung, since a percentage height stops at the first ancestor without one //
      (docs/11 §11.5).
      */}
      <div className="legere-viewer">
        {/* 🔒 Nothing whatever stands above the tabs: they are the one strip of chrome this column
          spends, and the open tab takes the rest of the height the viewport has. A name read once on
          arrival must not be charged to every page of every document, and the thing it names is on
          the screen being looked at — so the name is beside the document rather than over it
          (docs/11 §11.5).
          🔒 And nothing around them either: no card, no border, no padding of its own. A frame drawn
          round the whole zone is a frame drawn round the one thing the screen exists to show — the
          document's own page is the surface here, and the panel beside it keeps its cards. */}
        <div className="legere-viewer-main">
          <Tabs
            activeKey={active}
            // `replace`, not `push`: reading a document is one visit, and three tabs should not cost
            // three presses of the browser's back button to leave.
            onChange={(key) => {
              if (!isViewerTab(key)) return;
              setPendingTab({ documentId: id, from: tab, to: key });
              router.replace(`/documents/${id}/${key}`);
            }}
            items={[
              {
                key: 'preview',
                label: t('viewer.tabs.preview'),
                children: <PreviewPane document={detail} />,
              },
              {
                key: 'text',
                label: t('viewer.tabs.text'),
                children: (
                  <TextPane
                    document={detail}
                    markdown={markdown.data?.markdown ?? null}
                    loading={markdown.isPending}
                    isAdmin={isAdmin}
                    onReadAgain={() => readAgain.mutate()}
                    readingAgain={readAgain.isPending}
                  />
                ),
              },
              {
                key: 'related',
                label: t('viewer.tabs.related'),
                children: <RelatedPane id={id} active={active === 'related'} isAdmin={isAdmin} />,
              },
              {
                key: 'log',
                label: t('viewer.tabs.log'),
                children: <LogPane document={detail} active={active === 'log'} isAdmin={isAdmin} />,
              },
              {
                key: 'details',
                label: t('viewer.tabs.details'),
                children: (
                  <DetailsPane
                    document={detail}
                    documentTypes={documentTypes.data?.items ?? []}
                    people={people.data?.items ?? []}
                    subjects={subjects.data?.items ?? []}
                    subjectKinds={subjectKinds.data?.items ?? []}
                    // A kind is a row now (docs/03 §3.3.20a), and one the catalogue has never seen
                    // is created here rather than refused: the person filing a boat should not have
                    // to go and invent "boat" somewhere else first.
                    onCreateSubject={async (kind, name) => {
                      const wanted = kind.trim().toLowerCase();
                      const known = (subjectKinds.data?.items ?? []).find(
                        (candidate) => candidate.name.toLowerCase() === wanted,
                      );
                      const kindId =
                        known?.id ?? (await subjectKindApi.create({ name: wanted })).id;
                      const created = await subjectApi.create({ kindId, name });
                      await Promise.all([
                        queryClient.invalidateQueries({ queryKey: subjectKeys.all }),
                        queryClient.invalidateQueries({ queryKey: subjectKindKeys.all }),
                      ]);
                      return created.id;
                    }}
                    onCreatePerson={async (name) => {
                      const created = await personApi.create({ name });
                      await queryClient.invalidateQueries({ queryKey: personKeys.all });
                      return created.id;
                    }}
                    onSave={(input) => update.mutate(input)}
                    saving={update.isPending}
                  />
                ),
              },
              {
                key: 'files',
                label: t('viewer.tabs.files'),
                children: <FilesPane document={detail} isAdmin={isAdmin} />,
              },
            ]}
          />
        </div>

        {/* The panel of things about the document scrolls in itself as well, so what is on the left
          stays where it is while what is on the right is read (docs/11 §11.5). */}
        <aside className="legere-viewer-side">
          {/* The panel of things *about* the document opens with what it is called, which is where
              the rest of what is known about it already lives (docs/11 §11.5). 🔒 There is exactly
              one title and one description on the screen: a name rendered twice is a name somebody
              edits in the wrong place. */}
          <Card className="legere-viewer-identity">
            {/* Wrapping rather than truncating, and breaking a long word rather than escaping the
                column: a document's name is the one string here nobody may be shown half of. */}
            <Typography.Title
              level={1}
              style={{ fontSize: 18, marginTop: 0, marginBottom: 8, wordBreak: 'break-word' }}
              editable={{
                onChange: (title) => {
                  if (title.trim() !== '' && title !== detail.title) update.mutate({ title });
                },
                triggerType: ['icon', 'text'],
                // Names the pencil as well as its tooltip: two pencils on one panel both called
                // "Edit" are two controls nobody listening to the page can tell apart.
                tooltip: t('viewer.editTitle'),
              }}
            >
              {detail.title}
            </Typography.Title>

            {/* What this document is, for somebody who has never seen it — directly under the name,
                in secondary text, edited in place on the same terms (docs/11 §11.5). An em dash
                where the analysis has written none: a blank reads as a rendering bug, and the dash
                is also what there is to click on to write one. */}
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0 }}
              editable={{
                // The value, never the em dash standing in for it: an editor seeded with "—" would
                // make the placeholder the description the moment somebody pressed Enter.
                text: detail.description ?? '',
                onChange: (description) => {
                  const next = description.trim() === '' ? null : description.trim();
                  if (next !== detail.description) update.mutate({ description: next });
                },
                triggerType: ['icon', 'text'],
                autoSize: { minRows: 2, maxRows: 8 },
                tooltip: t('viewer.editDescription'),
              }}
            >
              {detail.description ?? '—'}
            </Typography.Paragraph>

            {/* What the analysis would have called it, when somebody has since called it something
                else — in the same place every other correction keeps its provenance, and a click
                away from being the name again (docs/11 §11.5). */}
            {detail.auto.title !== undefined && detail.auto.title !== detail.title && (
              <div className="legere-definition-note" style={{ marginTop: 8 }}>
                <Tooltip title={t('viewer.details.applyRead')}>
                  <Button
                    size="small"
                    type="link"
                    className="legere-definition-note-action"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ reset: ['title'] })}
                  >
                    {t('viewer.details.auto', { value: detail.auto.title })}
                  </Button>
                </Tooltip>
              </div>
            )}
          </Card>

          {detail.documentType?.slug === 'receipt' && (
            <Card>
              <Space orientation="vertical" size={10} style={{ width: '100%' }}>
                {detail.origin === 'LIBRARY' ? (
                  <Alert type="warning" showIcon title={t('viewer.moveToReceiptsLibrary')} />
                ) : detail.files.length !== 1 || detail.processing ? (
                  <Typography.Text type="secondary">
                    {t('viewer.moveToReceiptsUnavailable')}
                  </Typography.Text>
                ) : null}
                <Button
                  block
                  disabled={
                    detail.origin === 'LIBRARY' || detail.files.length !== 1 || detail.processing
                  }
                  loading={moveToReceipts.isPending}
                  onClick={() => {
                    modal.confirm({
                      title: t('viewer.moveToReceipts'),
                      content: t('viewer.moveToReceiptsConfirm'),
                      okText: t('viewer.moveToReceipts'),
                      onOk: () => moveToReceipts.mutate(),
                    });
                  }}
                >
                  {t('viewer.moveToReceipts')}
                </Button>
              </Space>
            </Card>
          )}

          {/* 🔒 What is left of the panel, and why (docs/11 §11.5): it says what the document is
              called, what it is about in a line, and what it looks like. Everything that *acts* on
              the document has gone to the tab that owns the question it answers — Download and
              Delete to Files, the links to Related, the pipeline to Log — because a panel carrying
              all of them was a second screen standing beside the first, drawn in full on every
              document whether or not anybody had come to act on one. */}
          <Card>
            {/* Only the caller's own collections: adding to somebody else's is not a thing a
                reader may do (docs/03 §3.4). */}
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('viewer.addToCollection')}
              aria-label={t('viewer.addToCollection')}
              loading={collections.isPending}
              value={null}
              onChange={(collectionId: string) => addToCollection.mutate(collectionId)}
              options={(collections.data?.items ?? [])
                .filter((collection) => collection.mine)
                .map((collection) => ({ value: collection.id, label: collection.name }))}
            />
          </Card>

          {/* The page itself, last in the panel (docs/11 §11.5). Small on purpose: the readable copy
              is the pane on the left, and this is the answer to "is this the right document" —
              which is a glance, not a read. */}
          {detail.hasPreview && (
            <Card styles={{ body: { padding: 8 } }}>
              <DocumentImage
                src={documentFiles.preview(detail.id)}
                alt=""
                loading="lazy"
                style={{
                  display: 'block',
                  width: '100%',
                  maxHeight: 320,
                  objectFit: 'contain',
                  // A page has an edge; a floating bitmap does not (docs/11 §11.15).
                  background: 'var(--legere-well)',
                }}
              />
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
