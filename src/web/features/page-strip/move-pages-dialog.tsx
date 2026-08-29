'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Modal, Radio, Select, Space, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { documentApi, documentKeys } from '../../entities/document';
import { searchApi, searchKeys } from '../../entities/search';
import { useDebouncedValue, useErrorMessage } from '../../shared/lib';

// "Move to…" of docs/11 §11.5a: the pages that belong elsewhere go there instead of being scanned
// again (docs/05 §5.6). Two answers to one question — an existing document, or a new one made to
// hold them — because those are the only two places a page can go, and asking which before asking
// where keeps the search out of the way of the commoner of the two.
//
// 🔒 What moves is the **entry**, not the bytes: the same file is simply read by pages in two places
// (ADR-025). The dialog says so rather than letting "move" sound like a copy.

// 🔒 A word typed at speed costs one search, not six — the same debounce the overlay uses
// (docs/11 §11.1a). Here it is not only politeness: every non-text search spends an outbound
// embeddings call and is metered at 30 per 60 s per caller (docs/08 §8.4), so a title typed a
// character at a time used to end in `RATE_LIMITED` and an empty list.
const DEBOUNCE_MS = 250;

// One page of the document as the dialog names it: the number the tile it was ticked on carries
// (docs/11 §11.5a). The dialog "says which it will move", and a page's number in the document is
// what a person reads off the strip.
export type MovingPage = { id: string; position: number };

export type MovePagesDialogProps = {
  open: boolean;
  documentId: string;
  pages: readonly MovingPage[];
  onClose: () => void;
  onMoved: () => void;
};

type Destination = 'new' | 'existing';

export function MovePagesDialog({
  open,
  documentId,
  pages,
  onClose,
  onMoved,
}: MovePagesDialogProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();
  const { message } = App.useApp();

  const [destination, setDestination] = useState<Destination>('new');
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string | null>(null);

  // Opening the dialog starts it afresh: a target chosen for one selection has nothing to do with
  // the next. Adjusted during render rather than in an effect, so the first frame anybody sees is
  // already empty.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
    setDestination('new');
    setQuery('');
    setTarget(null);
  }
  if (!open && opened) setOpened(false);

  // The same search everything else is found by (docs/11 §11.5e), and settled before it is asked:
  // typing a title is one search, not one per character.
  const typed = query.trim();
  const debounced = useDebouncedValue(typed, DEBOUNCE_MS);
  const found = useQuery({
    queryKey: searchKeys.query({ q: debounced, mode: 'hybrid' }),
    queryFn: () => searchApi.search({ q: debounced, mode: 'hybrid' }),
    enabled: open && destination === 'existing' && debounced !== '',
  });

  const move = useMutation({
    mutationFn: () =>
      documentApi.movePages(documentId, {
        pageIds: pages.map((page) => page.id),
        documentId: destination === 'new' ? null : target,
      }),
    onSuccess: (result) => {
      // Both ends are rebuilding, and either can appear in any list — hence the shared prefix.
      void queryClient.invalidateQueries({ queryKey: documentKeys.detail(documentId) });
      void queryClient.invalidateQueries({
        queryKey: documentKeys.detail(result.movedToDocumentId),
      });
      void queryClient.invalidateQueries({ queryKey: documentKeys.events(documentId) });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void message.success(t('viewer.pages.movedDone'), 3);
      onMoved();
      onClose();
    },
    // The modal closes on the answer, not on the click, so a refusal is visible where it happened —
    // and a move is refused whole rather than done by halves (docs/07 §7.3).
    onError: (error: unknown) => void message.error(describeError(error)),
  });

  const options = (found.data?.items ?? [])
    .filter((hit) => hit.document.id !== documentId)
    .map((hit) => ({ value: hit.document.id, label: hit.document.title }));

  const ready = destination === 'new' || target !== null;

  // In document order, whichever order they were ticked in: the strip reads left to right, and a
  // list that said "12, 3, 5" would be about a document nobody is looking at.
  const numbers = pages
    .map((page) => page.position)
    .sort((one, other) => one - other)
    .join(', ');

  return (
    <Modal
      open={open}
      title={t('viewer.pages.moveTitle')}
      onCancel={onClose}
      okText={t('viewer.pages.moveConfirm')}
      cancelText={t('viewer.pages.moveCancel')}
      okButtonProps={{ disabled: !ready, loading: move.isPending }}
      onOk={() => move.mutate()}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* 🔒 Which pages are leaving, by the numbers the tiles they were ticked on carry
            (docs/11 §11.5a). A tile's own Move and a Move of twelve ticked pages are the same
            dialog, and without this it was the same *generic* dialog: a confirmation that does not
            say what it is about is one nobody can check before pressing it. */}
        <Typography.Text strong>
          {t('viewer.pages.moveWhat', { count: pages.length, pages: numbers })}
        </Typography.Text>

        <Radio.Group
          value={destination}
          onChange={(event) =>
            setDestination(event.target.value === 'existing' ? 'existing' : 'new')
          }
        >
          <Space direction="vertical" size={4}>
            <Radio value="new">{t('viewer.pages.moveToNew')}</Radio>
            <Radio value="existing">{t('viewer.pages.moveToExisting')}</Radio>
          </Space>
        </Radio.Group>

        {destination === 'existing' && (
          <Select
            showSearch
            // The server ranks; re-filtering by label here would second-guess it.
            filterOption={false}
            style={{ width: '100%' }}
            placeholder={t('viewer.pages.moveSearch')}
            aria-label={t('viewer.pages.moveSearch')}
            value={target}
            onSearch={setQuery}
            // Between the keystroke and the answer the list is neither: it is waiting.
            loading={found.isFetching || debounced !== typed}
            onChange={(id: string) => setTarget(id)}
            options={options}
            notFoundContent={null}
          />
        )}

        {/* 🔒 No bytes are copied and no file is extracted: the same file is read by pages in two
            places (ADR-025). Said here because "move" is the one word on this screen that could be
            read as taking something away from the library. */}
        <Typography.Text type="secondary">{t('viewer.pages.moveHint')}</Typography.Text>
      </Space>
    </Modal>
  );
}
