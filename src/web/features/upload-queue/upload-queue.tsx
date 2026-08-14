'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { documentApi, documentKeys } from '../../entities/document';
import type { UploadProgress } from '../../shared/api';
import { useErrorMessage } from '../../shared/lib';

// Where one file is on its way (docs/11 §11.3). `duplicate` is not a failure: those bytes were
// already on the instance, and the row carries the id of the document that has them (ADR-009).
export type UploadStatus = 'waiting' | 'uploading' | 'done' | 'duplicate' | 'failed';

export type UploadQueueItem = {
  key: string;
  fileName: string;
  size: number;
  // Absent for a file that becomes a document of its own; present when it is appended to one.
  targetDocumentId?: string;
  status: UploadStatus;
  loadedBytes: number;
  error?: string;
  // The document this row ended at: the new one, or the one the bytes were already in.
  resultDocumentId?: string;
  settledAt?: number;
};

export type UploadTarget = { documentId: string };

export type UploadQueue = {
  items: readonly UploadQueueItem[];
  busy: boolean;
  send: (files: File[], target?: UploadTarget) => void;
  retry: (key: string) => void;
  retryFailed: () => void;
  clearAll: () => void;
};

// The file itself never leaves this module: what the panel draws is a name, a size and a status.
type QueueEntry = UploadQueueItem & { file: File };

// What one finished upload leaves on its row.
type Settlement =
  | { status: 'done'; resultDocumentId: string }
  | { status: 'duplicate'; resultDocumentId: string }
  | { status: 'failed'; error: string };

const UploadQueueContext = createContext<UploadQueue | null>(null);

// A row that will not move again — whether it arrived, deduplicated, or failed.
export function isSettled(item: UploadQueueItem): boolean {
  return item.status === 'done' || item.status === 'duplicate' || item.status === 'failed';
}

export function useUploadQueue(): UploadQueue {
  const queue = use(UploadQueueContext);
  if (queue === null) {
    throw new Error('useUploadQueue is only available inside an UploadQueueProvider.');
  }
  return queue;
}

// The instance's one upload queue (docs/11 §11.3). A queue, not a fan-out: files go **one at a
// time**, in the order they were chosen, whichever screen chose them. Forty parallel uploads would
// saturate the connection, arrive interleaved and make the pipeline queue jump about; one at a time
// is slower to finish and far easier to watch. It lives above the screens because an upload outlives
// the screen it was started from — walking to another page must not abandon it.
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const describeError = useErrorMessage();

  // The ref is the queue; the state is what the panel renders from it. One source of truth, so the
  // pump never reads a stale closure while React catches up.
  const entries = useRef<QueueEntry[]>([]);
  const [items, setItems] = useState<readonly QueueEntry[]>([]);
  const running = useRef(false);
  const inFlight = useRef<AbortController | null>(null);
  const nextKey = useRef(0);

  const update = useCallback((change: (current: QueueEntry[]) => QueueEntry[]) => {
    entries.current = change(entries.current);
    setItems(entries.current);
  }, []);

  const patch = useCallback(
    (key: string, change: (entry: QueueEntry) => QueueEntry) => {
      update((current) => current.map((entry) => (entry.key === key ? change(entry) : entry)));
    },
    [update],
  );

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = entries.current.find((entry) => entry.status === 'waiting');
        if (next === undefined) return;
        patch(next.key, (entry) => ({ ...entry, status: 'uploading', loadedBytes: 0 }));

        const controller = new AbortController();
        inFlight.current = controller;

        // Redrawn only when the whole percent moves: a hundred-megabyte scan fires progress events
        // by the hundred, and a row that re-renders on every one of them costs more than it says.
        let shown = -1;
        const onProgress: UploadProgress = (loadedBytes, totalBytes) => {
          const percent = totalBytes === 0 ? 0 : Math.floor((loadedBytes * 100) / totalBytes);
          if (percent === shown) return;
          shown = percent;
          patch(next.key, (entry) => ({ ...entry, loadedBytes }));
        };

        let settlement: Settlement;
        try {
          settlement = await sendOne(next, onProgress, controller.signal);
        } catch (error: unknown) {
          // The row stays, wearing its own error; the queue carries on. One rejected file must not
          // take the other thirty-nine with it.
          settlement = { status: 'failed', error: describeError(error) };
        } finally {
          inFlight.current = null;
        }

        // A queue emptied mid-flight has no row left to settle and nothing to refresh: that upload
        // was abandoned on purpose, and its abort must not write anything back.
        if (!entries.current.some((entry) => entry.key === next.key)) continue;
        patch(next.key, (entry) => ({ ...entry, ...settlement, settledAt: Date.now() }));

        // Every filter combination shows a different slice and a new document may belong to any of
        // them, hence the shared prefix. Per file rather than per batch: forty files arriving one by
        // one should appear one by one.
        await queryClient.invalidateQueries({ queryKey: ['documents'] });
        if (next.targetDocumentId !== undefined) {
          await queryClient.invalidateQueries({
            queryKey: documentKeys.detail(next.targetDocumentId),
          });
        }
      }
    } finally {
      running.current = false;
    }
  }, [describeError, patch, queryClient]);

  const send = useCallback(
    (files: File[], target?: UploadTarget) => {
      if (files.length === 0) return;
      update((current) => [
        ...current,
        ...files.map((file): QueueEntry => {
          nextKey.current += 1;
          return {
            key: `upload-${nextKey.current}`,
            file,
            fileName: file.name,
            size: file.size,
            status: 'waiting',
            loadedBytes: 0,
            ...(target === undefined ? {} : { targetDocumentId: target.documentId }),
          };
        }),
      ]);
      void pump();
    },
    [pump, update],
  );

  const retry = useCallback(
    (key: string) => {
      update((current) =>
        current.map((entry) =>
          entry.key === key && entry.status === 'failed' ? requeue(entry) : entry,
        ),
      );
      void pump();
    },
    [pump, update],
  );

  const retryFailed = useCallback(() => {
    update((current) =>
      current.map((entry) => (entry.status === 'failed' ? requeue(entry) : entry)),
    );
    void pump();
  }, [pump, update]);

  const clearAll = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    update(() => []);
  }, [update]);

  const value = useMemo<UploadQueue>(
    () => ({
      items,
      busy: items.some((item) => item.status === 'waiting' || item.status === 'uploading'),
      send,
      retry,
      retryFailed,
      clearAll,
    }),
    [clearAll, items, retry, retryFailed, send],
  );

  return <UploadQueueContext value={value}>{children}</UploadQueueContext>;
}

// The row goes back to where it started, in place: same key, same position, nothing left of the
// attempt that failed.
function requeue(entry: QueueEntry): QueueEntry {
  const {
    error: _error,
    resultDocumentId: _resultDocumentId,
    settledAt: _settledAt,
    ...rest
  } = entry;
  return { ...rest, status: 'waiting', loadedBytes: 0 };
}

// Which of the three things happened. Deduplication doing its job is one of them, not an error
// (ADR-009): the bytes are already here, and the row says which document has them.
async function sendOne(
  entry: QueueEntry,
  onProgress: UploadProgress,
  signal: AbortSignal,
): Promise<Settlement> {
  if (entry.targetDocumentId !== undefined) {
    const document = await documentApi.addFile(
      entry.targetDocumentId,
      entry.file,
      onProgress,
      signal,
    );
    return { status: 'done', resultDocumentId: document.id };
  }
  const result = await documentApi.upload(entry.file, onProgress, signal);
  return {
    status: result.created ? 'done' : 'duplicate',
    resultDocumentId: result.document.id,
  };
}
