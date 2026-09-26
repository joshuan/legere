'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DisconnectOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Empty,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { type DocumentLinkSuggestion } from '../../../../shared/contracts/documents';
import { documentApi, documentKeys } from '../../../entities/document';
import { searchApi, searchKeys } from '../../../entities/search';
import { useErrorMessage, formatBytes } from '../../../shared/lib';
import { DocumentThumb, PreviewPane } from './preview-pane';
import { TextPane } from './text-pane';
import { LogPane } from './log-pane';
import { DetailsPane } from './details-pane';
import { FilesPane } from './files-pane';

// Download is a split button (docs/11 §11.5b): its main half is the document as one piece, its
// dropdown the originals it was made of. The default is never silently an original — a document made
// of forty photographs downloads as one PDF, and whoever wants photograph 23 asks for it by name.
// What a reader dismissed, for this session (docs/05 §5.6b): the server proposes and never
// remembers being refused, so the refusal lives here — and only until the tab closes.
const dismissedLinksKey = (id: string): string => `legere:dismissed-link-suggestions:${id}`;

function readDismissed(id: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(dismissedLinksKey(id));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(id: string, ids: readonly string[]): void {
  try {
    window.sessionStorage.setItem(dismissedLinksKey(id), JSON.stringify(ids));
  } catch {
    // A full store is not a reason dismissing should break.
  }
}

// The edges of this document (docs/03 §3.3.23, docs/11 §11.5e): a picker for linking by hand, the
// linked documents, and beneath them — quieter — the candidates the archive found by the identifiers
// they share (docs/05 §5.6b), each saying which ones matched.
//
// A tab rather than a card in the sidebar: a link is a document, and a document deserves the width
// one is shown at — in an 8/24 column each was a truncated line of text, and the picker had one
// search box's worth of room to answer in. 🔒 The tab is drawn whether or not there is anything in
// it: the card's "draw nothing at all" was right for a card standing in a panel nobody asked to see,
// but a tab that vanished with the last link would take the picker with it, and the first link could
// then only be made on a document that already has one.
export function RelatedPane({
  id,
  active,
  isAdmin,
}: {
  id: string;
  active: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();
  const [dismissed, setDismissed] = useState<readonly string[]>(() => readDismissed(id));
  const [query, setQuery] = useState('');
  // Which proposal is being read (docs/11 §11.5e). A row is a title and a thumbnail, which is enough
  // to tell two acts apart and not enough to decide anything about them — so pressing one opens the
  // document itself, and the decision is taken with the paper on screen.
  const [peeked, setPeeked] = useState<DocumentLinkSuggestion | null>(null);

  // Fetched only when the tab is open, exactly like the log: the suggestions cost the server one
  // search per identifier this document carries (docs/05 §5.6b), and most visits never ask.
  const links = useQuery({
    queryKey: documentKeys.links(id),
    queryFn: () => documentApi.links(id),
    enabled: active,
  });
  const suggestions = useQuery({
    queryKey: documentKeys.linkSuggestions(id),
    queryFn: () => documentApi.linkSuggestions(id),
    enabled: active,
  });
  // The same search the overlay runs (docs/11 §11.5e): papers related only in somebody's head are
  // found the way anything is found.
  const found = useQuery({
    queryKey: searchKeys.query({ q: query, mode: 'hybrid' }),
    queryFn: () => searchApi.search({ q: query, mode: 'hybrid' }),
    enabled: query.trim().length > 0,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.links(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.linkSuggestions(id) });
    void queryClient.invalidateQueries({ queryKey: documentKeys.events(id) });
  };

  const link = useMutation({
    mutationFn: (documentId: string) => documentApi.createLink(id, documentId),
    onSuccess: () => {
      setQuery('');
      setPeeked(null);
      refresh();
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });
  const unlink = useMutation({
    mutationFn: (documentId: string) => documentApi.deleteLink(id, documentId),
    onSuccess: refresh,
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // "These are not two papers": the other document's files are appended to this one and its own
  // record goes (docs/05 §5.6), and this document is rebuilt from the whole. The reader stays where
  // they are — the survivor is the document they are already reading (docs/11 §11.5e).
  const combine = useMutation({
    mutationFn: (documentId: string) => documentApi.combine(id, { documentIds: [documentId] }),
    onSuccess: () => {
      void message.success(t('viewer.links.combined'), 3);
      setPeeked(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: documentKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: documentKeys.markdown(id) });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  // 🔒 "The same paper, scanned twice": the copy that is not being read is deleted rather than
  // merged into a document that would then hold every page twice (docs/03 §3.3.10, docs/11 §11.5e).
  // Admin only, because the endpoint is.
  const duplicate = useMutation({
    mutationFn: (documentId: string) => documentApi.remove(documentId),
    onSuccess: () => {
      void message.success(t('viewer.links.duplicateDone'), 3);
      setPeeked(null);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const deciding = link.isPending || combine.isPending || duplicate.isPending;

  const linked = links.data?.items ?? [];
  const linkedIds = new Set(linked.map((item) => item.document.id));
  const proposals = (suggestions.data?.items ?? []).filter(
    (candidate) =>
      !linkedIds.has(candidate.document.id) && !dismissed.includes(candidate.document.id),
  );

  const options = (found.data?.items ?? [])
    .filter((hit) => hit.document.id !== id && !linkedIds.has(hit.document.id))
    .map((hit) => ({ value: hit.document.id, label: hit.document.title }));

  const dismiss = (documentId: string): void => {
    setDismissed((current) => {
      const next = [...current, documentId];
      writeDismissed(id, next);
      return next;
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* Above the list rather than under it, for the reason Add files stands above the file rows:
          the thing somebody came to do is not at the bottom of what is already done. */}
      <Select
        showSearch
        // The server ranks; re-filtering by label here would second-guess it.
        filterOption={false}
        style={{ width: '100%', maxWidth: 480 }}
        placeholder={t('viewer.links.link')}
        aria-label={t('viewer.links.link')}
        value={null}
        onSearch={setQuery}
        loading={found.isFetching}
        onChange={(documentId: string) => link.mutate(documentId)}
        options={options}
        notFoundContent={null}
      />

      {linked.length === 0 ? (
        <Empty description={t('viewer.links.none')} />
      ) : (
        <List
          dataSource={linked}
          rowKey={(item) => item.document.id}
          size="small"
          renderItem={(item) => (
            <List.Item
              actions={[
                <Tooltip key="unlink" title={t('viewer.links.unlink')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<DisconnectOutlined />}
                    aria-label={t('viewer.links.unlink')}
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate(item.document.id)}
                  />
                </Tooltip>,
              ]}
            >
              <List.Item.Meta
                avatar={<DocumentThumb document={item.document} />}
                title={<Link href={`/documents/${item.document.id}`}>{item.document.title}</Link>}
                description={
                  item.document.documentType === null ? null : (
                    <Tag>{item.document.documentType.name}</Tag>
                  )
                }
              />
            </List.Item>
          )}
        />
      )}

      {proposals.length > 0 && (
        <>
          {/* Quieter than the links, and under a heading of their own: a proposal is not a fact
              about the document until somebody says so (docs/05 §5.6b). */}
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t('viewer.links.suggestions')}
          </Typography.Title>
          <List
            dataSource={proposals}
            rowKey={(candidate) => candidate.document.id}
            size="small"
            renderItem={(candidate) => (
              <List.Item
                actions={[
                  <Button
                    key="accept"
                    size="small"
                    type="link"
                    disabled={deciding}
                    onClick={() => link.mutate(candidate.document.id)}
                  >
                    {t('viewer.links.accept')}
                  </Button>,
                  // The two answers a pair of papers can have besides "they are related", offered on
                  // the row and again at the foot of the peek, so neither is somewhere the other is
                  // not (docs/11 §11.5e). Both are confirmed first: a press in a list of proposals
                  // is a smaller gesture than what it agrees to.
                  <Popconfirm
                    key="combine"
                    title={t('viewer.links.combineConfirm')}
                    description={t('viewer.links.combineNote', {
                      title: candidate.document.title,
                    })}
                    okText={t('viewer.links.combine')}
                    cancelText={t('common.actions.cancel')}
                    onConfirm={() => combine.mutate(candidate.document.id)}
                  >
                    <Button size="small" type="link" disabled={deciding}>
                      {t('viewer.links.combine')}
                    </Button>
                  </Popconfirm>,
                  ...(isAdmin
                    ? [
                        <Popconfirm
                          key="duplicate"
                          title={t('viewer.links.duplicateConfirm', {
                            title: candidate.document.title,
                          })}
                          description={t('viewer.links.duplicateNote', {
                            files: candidate.document.fileCount,
                            size: formatBytes(candidate.document.sizeBytes),
                          })}
                          okText={t('viewer.links.duplicate')}
                          okButtonProps={{ danger: true }}
                          cancelText={t('common.actions.cancel')}
                          onConfirm={() => duplicate.mutate(candidate.document.id)}
                        >
                          <Button size="small" type="link" danger disabled={deciding}>
                            {t('viewer.links.duplicate')}
                          </Button>
                        </Popconfirm>,
                      ]
                    : []),
                  <Button
                    key="dismiss"
                    size="small"
                    type="text"
                    onClick={() => dismiss(candidate.document.id)}
                  >
                    {t('viewer.links.dismiss')}
                  </Button>,
                ]}
              >
                {/* The row is the way into the document it proposes: pressing the thumbnail or the
                    title opens it in place, read-only, with the decision at its foot (docs/11
                    §11.5e). A button rather than a div with a handler, so it is reachable by
                    keyboard and announced as what it is. */}
                <button
                  type="button"
                  className="legere-row-button"
                  aria-label={t('viewer.links.peek', { title: candidate.document.title })}
                  onClick={() => setPeeked(candidate)}
                >
                  <List.Item.Meta
                    avatar={<DocumentThumb document={candidate.document} />}
                    title={
                      <Typography.Text type="secondary">{candidate.document.title}</Typography.Text>
                    }
                    // Why this is here (docs/05 §5.6b): the identifiers the two documents share.
                    description={t('viewer.links.cites', {
                      tokens: candidate.matchedTokens.join(', '),
                    })}
                  />
                </button>
              </List.Item>
            )}
          />
        </>
      )}

      {peeked !== null && (
        <DocumentPeek
          candidate={peeked}
          isAdmin={isAdmin}
          deciding={deciding}
          onLink={() => link.mutate(peeked.document.id)}
          onCombine={() => combine.mutate(peeked.document.id)}
          onDuplicate={() => duplicate.mutate(peeked.document.id)}
          onClose={() => setPeeked(null)}
        />
      )}
    </Space>
  );
}

// A suggested document, read where it was suggested (docs/11 §11.5e): the candidate drawn as the
// viewer draws it — the canonical PDF, the text, the log, the details, the files — with its title at
// the head as the way into the full viewer, and at the foot the three things a reader may decide
// about the pair.
//
// 🔒 It reads and never writes: every pane is given its read-only state, so nothing here edits,
// uploads, re-runs, crops, reorders, splits or deletes. An editor opened in a peek is an editor
// nobody navigated to, and the paper it would correct is not the one the question is about.
//
// 🔒 And it draws no Related tab of its own: suggestions inside a suggestion are a corridor, and the
// question in front of the reader is about the two documents they already have.
function DocumentPeek({
  candidate,
  isAdmin,
  deciding,
  onLink,
  onCombine,
  onDuplicate,
  onClose,
}: {
  candidate: DocumentLinkSuggestion;
  isAdmin: boolean;
  deciding: boolean;
  onLink: () => void;
  onCombine: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [active, setActive] = useState<PeekTab>('preview');
  const proposed = candidate.document;

  const document = useQuery({
    queryKey: documentKeys.detail(proposed.id),
    queryFn: () => documentApi.get(proposed.id),
  });
  // Asked for when the text is opened and not before, exactly as the log is (docs/11 §11.5e): a
  // look at a document is usually a look at its first page, and the peek costs one fetch.
  const markdown = useQuery({
    queryKey: documentKeys.markdown(proposed.id),
    queryFn: () => documentApi.markdown(proposed.id),
    enabled: active === 'text',
  });

  const detail = document.data;

  return (
    <Modal
      open
      width={960}
      onCancel={onClose}
      // The title is the document's own, and it is the way to the screen where the document may be
      // worked on: a peek deliberately has no such place in it.
      title={
        <Space size={8} wrap>
          <Link href={`/documents/${proposed.id}`}>{proposed.title}</Link>
          <Typography.Text type="secondary">
            {t('viewer.links.cites', { tokens: candidate.matchedTokens.join(', ') })}
          </Typography.Text>
        </Space>
      }
      footer={[
        ...(isAdmin
          ? [
              <Popconfirm
                key="duplicate"
                title={t('viewer.links.duplicateConfirm', { title: proposed.title })}
                description={t('viewer.links.duplicateNote', {
                  files: proposed.fileCount,
                  size: formatBytes(proposed.sizeBytes),
                })}
                okText={t('viewer.links.duplicate')}
                okButtonProps={{ danger: true }}
                cancelText={t('common.actions.cancel')}
                onConfirm={onDuplicate}
              >
                <Button danger disabled={deciding || detail === undefined}>
                  {t('viewer.links.duplicate')}
                </Button>
              </Popconfirm>,
            ]
          : []),
        <Popconfirm
          key="combine"
          title={t('viewer.links.combineConfirm')}
          description={t('viewer.links.combineNote', { title: proposed.title })}
          okText={t('viewer.links.combine')}
          cancelText={t('common.actions.cancel')}
          onConfirm={onCombine}
        >
          <Button disabled={deciding || detail === undefined}>{t('viewer.links.combine')}</Button>
        </Popconfirm>,
        // Closing a look is not refusing a suggestion: the row keeps Dismiss (docs/11 §11.5e).
        <Button key="cancel" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>,
        <Button
          key="link"
          type="primary"
          loading={deciding}
          disabled={detail === undefined}
          onClick={onLink}
        >
          {t('viewer.links.accept')}
        </Button>,
      ]}
    >
      {detail === undefined ? (
        <Spin />
      ) : (
        <div className="legere-peek">
          <Tabs
            activeKey={active}
            onChange={(key) => setActive(isPeekTab(key) ? key : 'preview')}
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
                    isAdmin={false}
                  />
                ),
              },
              {
                key: 'log',
                label: t('viewer.tabs.log'),
                children: <LogPane document={detail} active={active === 'log'} isAdmin={false} />,
              },
              {
                key: 'details',
                label: t('viewer.tabs.details'),
                children: <DetailsPane document={detail} readOnly />,
              },
              {
                key: 'files',
                label: t('viewer.tabs.files'),
                // 🔒 `isAdmin` is false whoever is reading: what an admin may decide about the
                // pair is at the foot of the peek, and the pane itself offers nothing to anybody
                // (docs/11 §11.5e).
                children: <FilesPane document={detail} isAdmin={false} readOnly />,
              },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}

// The tabs of a peek: the viewer's own, minus the one that would draw another list of documents
// (docs/11 §11.5e).
const PEEK_TABS = ['preview', 'text', 'log', 'details', 'files'] as const;

type PeekTab = (typeof PEEK_TABS)[number];

function isPeekTab(value: string): value is PeekTab {
  return PEEK_TABS.some((tab) => tab === value);
}
