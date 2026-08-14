import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import type { UploadQueue, UploadQueueItem, UploadStatus } from '../../features/upload-queue';
import { UploadPanel } from './upload-panel';
import { UploadPanelLayout } from './upload-panel-layout';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// The panel is a view of the queue, so the queue is the fixture here: the store has tests of its own
// and driving five statuses through real uploads would test the transport instead of the panel.
const held = vi.hoisted(() => {
  const holder: { queue: UploadQueue | null } = { queue: null };
  return holder;
});

vi.mock('../../features/upload-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../features/upload-queue')>();
  return {
    ...actual,
    useUploadQueue: () => {
      if (held.queue === null) throw new Error('no queue was set up for this test');
      return held.queue;
    },
  };
});

const send = vi.fn();
const retry = vi.fn();
const retryFailed = vi.fn();
const clearAll = vi.fn();

const PANEL = enMessages.documents.upload.panel;
const DOCUMENT_ID = 'aaaaaaaa-1111-4111-8111-000000000009';

function row(
  fileName: string,
  status: UploadStatus,
  rest: Partial<UploadQueueItem> = {},
): UploadQueueItem {
  return {
    key: fileName,
    fileName,
    size: 100,
    status,
    loadedBytes: status === 'waiting' ? 0 : 100,
    ...rest,
  };
}

function setQueue(items: UploadQueueItem[]): void {
  held.queue = {
    items,
    busy: items.some((item) => item.status === 'waiting' || item.status === 'uploading'),
    send,
    retry,
    retryFailed,
    clearAll,
  };
}

function fileNamesInOrder(): string[] {
  return Array.from(document.querySelectorAll('[data-upload-key]')).map(
    (element) => element.getAttribute('data-upload-key') ?? '',
  );
}

beforeEach(() => {
  held.queue = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('UploadPanel', () => {
  it('says nothing at all while the queue is empty', () => {
    setQueue([]);
    renderWithProviders(<UploadPanel />);

    expect(screen.queryByLabelText(PANEL.label)).toBeNull();
  });

  it('draws one row per file, in the order they were added, each wearing its own status', () => {
    setQueue([
      row('Done.pdf', 'done', { resultDocumentId: DOCUMENT_ID }),
      row('Sending.pdf', 'uploading', { loadedBytes: 50 }),
      row('Waiting.pdf', 'waiting'),
      row('Twice.pdf', 'duplicate', { resultDocumentId: DOCUMENT_ID }),
      row('Bad.pdf', 'failed', { error: 'The connection went away.' }),
    ]);
    renderWithProviders(<UploadPanel />);

    // Never reordered: the column reads as the order the files were chosen in.
    expect(fileNamesInOrder()).toEqual([
      'Done.pdf',
      'Sending.pdf',
      'Waiting.pdf',
      'Twice.pdf',
      'Bad.pdf',
    ]);

    expect(screen.getByLabelText(PANEL.uploaded)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(PANEL.queued)).toBeInTheDocument();
    expect(screen.getByLabelText(PANEL.failed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PANEL.retry })).toBeInTheDocument();

    // The bytes were already here, and the row is the way to the document that has them (ADR-009).
    expect(screen.getByRole('link', { name: PANEL.duplicate })).toHaveAttribute(
      'href',
      `/documents/${DOCUMENT_ID}`,
    );
  });

  it('names the file it is truncating, so a long name is still readable', () => {
    setQueue([row('A very long scan of something.pdf', 'waiting')]);
    renderWithProviders(<UploadPanel />);

    expect(screen.getByTitle('A very long scan of something.pdf')).toBeInTheDocument();
  });

  it('counts what has settled while it works, and what arrived once it is over', () => {
    setQueue([row('One.pdf', 'done'), row('Two.pdf', 'uploading'), row('Three.pdf', 'waiting')]);
    const running = renderWithProviders(<UploadPanel />);

    expect(screen.getByText('Uploading 1 of 3')).toBeInTheDocument();
    running.unmount();

    setQueue([row('One.pdf', 'done'), row('Two.pdf', 'done'), row('Three.pdf', 'done')]);
    renderWithProviders(<UploadPanel />);

    expect(screen.getByText('3 files uploaded')).toBeInTheDocument();
  });

  it('offers to try the failures again only when there are some', async () => {
    setQueue([row('One.pdf', 'done'), row('Two.pdf', 'uploading')]);
    const clean = renderWithProviders(<UploadPanel />);

    expect(screen.queryByRole('button', { name: PANEL.retryFailed })).toBeNull();
    clean.unmount();

    setQueue([row('One.pdf', 'done'), row('Two.pdf', 'failed', { error: 'no' })]);
    renderWithProviders(<UploadPanel />);

    await userEvent.click(screen.getByRole('button', { name: PANEL.retryFailed }));
    expect(retryFailed).toHaveBeenCalledTimes(1);
  });

  it('asks before it throws away an upload that is still going', async () => {
    setQueue([row('One.pdf', 'uploading'), row('Two.pdf', 'waiting')]);
    renderWithProviders(<UploadPanel />);

    await userEvent.click(screen.getByRole('button', { name: PANEL.close }));

    expect(await screen.findByText(PANEL.closeConfirm)).toBeInTheDocument();
    expect(clearAll).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: PANEL.closeConfirmOk }));
    expect(clearAll).toHaveBeenCalledTimes(1);
  });

  it('just closes once nothing is in flight', async () => {
    setQueue([row('One.pdf', 'done'), row('Two.pdf', 'failed', { error: 'no' })]);
    renderWithProviders(<UploadPanel />);

    await userEvent.click(screen.getByRole('button', { name: PANEL.close }));

    expect(screen.queryByText(PANEL.closeConfirm)).toBeNull();
    expect(clearAll).toHaveBeenCalledTimes(1);
  });

  it('hands the file back to the queue when its own retry is pressed', async () => {
    setQueue([row('Bad.pdf', 'failed', { error: 'no' })]);
    renderWithProviders(<UploadPanel />);

    await userEvent.click(screen.getByRole('button', { name: PANEL.retry }));

    expect(retry).toHaveBeenCalledWith('Bad.pdf');
  });

  it('tells the reader why a file failed', async () => {
    setQueue([row('Bad.pdf', 'failed', { error: 'The connection went away.' })]);
    renderWithProviders(<UploadPanel />);

    await userEvent.hover(screen.getByLabelText(PANEL.failed));

    expect(await screen.findByText('The connection went away.')).toBeInTheDocument();
  });

  it('announces where it has got to without stealing the focus', () => {
    setQueue([row('One.pdf', 'done'), row('Two.pdf', 'uploading')]);
    renderWithProviders(<UploadPanel />);

    const live = document.querySelector('[aria-live="polite"]');
    if (!(live instanceof HTMLElement)) throw new Error('no live region');
    expect(within(live).getByText('Uploading 1 of 2')).toBeInTheDocument();
  });

  // The panel is the receipt for what was sent (docs/11 §11.3a): nothing takes it off the page
  // but ✕ — even a run that went through without a word stays to be read.
  describe('staying on the page', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps a finished clean run until it is closed', () => {
      setQueue([row('One.pdf', 'done'), row('Two.pdf', 'done')]);
      renderWithProviders(<UploadPanel />);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(clearAll).not.toHaveBeenCalled();
    });
  });
});

describe('UploadPanelLayout', () => {
  // 🔒 Not a wrapper that is merely empty: a flex row round a page with one child in it is already
  // a different page, and nothing is being uploaded on most of them.
  it('is the screen and nothing else while the queue is empty', () => {
    setQueue([]);
    renderWithProviders(
      <UploadPanelLayout>
        <p>the grid</p>
      </UploadPanelLayout>,
    );

    expect(screen.getByText('the grid')).toBeInTheDocument();
    expect(document.querySelector('.legere-upload-layout')).toBeNull();
  });

  it('puts the screen and the panel side by side as soon as there is something to show', () => {
    setQueue([row('One.pdf', 'uploading')]);
    renderWithProviders(
      <UploadPanelLayout>
        <p>the grid</p>
      </UploadPanelLayout>,
    );

    expect(screen.getByText('the grid')).toBeInTheDocument();
    expect(document.querySelector('.legere-upload-layout')).not.toBeNull();
    expect(screen.getByLabelText(PANEL.label)).toBeInTheDocument();
  });
});
