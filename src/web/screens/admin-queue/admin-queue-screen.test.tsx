import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueSettingsDto } from '../../../shared/contracts/queue';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminQueueScreen } from './admin-queue-screen';

const JOB_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

const overview = {
  queues: [
    { name: 'library-scan', queued: 0, active: 0, failedRecent: 0 },
    { name: 'file-ingest', queued: 3, active: 1, failedRecent: 0 },
    { name: 'document-process', queued: 2, active: 1, failedRecent: 4 },
    { name: 'scanset-merge', queued: 0, active: 0, failedRecent: 0 },
    { name: 'maintenance', queued: 0, active: 0, failedRecent: 0 },
  ],
  documents: {
    total: 12,
    steps: [
      { step: 'canonical', counts: { DONE: 5, SKIPPED: 7, PENDING: 0, FAILED: 0 } },
      { step: 'preview', counts: { DONE: 10, FAILED: 2, PENDING: 0, SKIPPED: 0 } },
      { step: 'markdown', counts: { DONE: 12, PENDING: 0, FAILED: 0, SKIPPED: 0 } },
      { step: 'analysis', counts: { SKIPPED: 12, PENDING: 0, DONE: 0, FAILED: 0 } },
      { step: 'vectorization', counts: { SKIPPED: 12, PENDING: 0, DONE: 0, FAILED: 0 } },
    ],
  },
  storage: { objects: 34, bytes: '1932735283', measuredAt: '2026-01-02T09:00:00.000Z' },
};

// What the settings endpoint answers with; `paused` is the list of queues nothing consumes.
const settings: QueueSettingsDto = {
  concurrency: {
    'library-scan': 1,
    'file-ingest': 4,
    'document-process': 2,
    'scanset-merge': 1,
    maintenance: 1,
  },
  unitConcurrency: 2,
  paused: [],
};

const failure = {
  jobId: JOB_ID,
  queue: 'document-process',
  payload: { documentId: 'bbbbbbbb-2222-4222-8222-222222222222' },
  error: 'Stirling /api/v1/misc/ocr-pdf failed with 500: tesseract crashed',
  failedAt: '2026-01-02T10:00:00.000Z',
  retryCount: 2,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/admin/queue/overview', () => HttpResponse.json(envelope(overview))),
    http.get('/api/admin/queue/failures', () =>
      HttpResponse.json(envelope({ items: [failure], nextCursor: null })),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminQueueScreen', () => {
  it('shows a card per queue with its depths', async () => {
    renderWithProviders(<AdminQueueScreen />);

    // One block per stage, including the quiet ones — five blocks, five "failed" figures.
    await waitFor(() =>
      expect(screen.getAllByText(enMessages.admin.queue.failedRecent)).toHaveLength(5),
    );
    expect(screen.getAllByText('document-process').length).toBeGreaterThan(0);
    expect(screen.getByText('file-ingest')).toBeInTheDocument();
    expect(screen.getByText('maintenance')).toBeInTheDocument();
  });

  it('shows where the documents stand in the pipeline', async () => {
    renderWithProviders(<AdminQueueScreen />);

    expect(await screen.findByText(enMessages.admin.queue.pipeline.title)).toBeInTheDocument();
    // The card is on screen before its data is; wait for the figure itself.
    expect(
      await screen.findByText((content) => content.replace(/\s+/g, ' ') === '12 documents'),
    ).toBeInTheDocument();
    // 🔒 The steps are named as the document's own page names them: one screen calling a step
    // "Тип" while the other calls it "Анализ" is two names for one thing (docs/11 §11.13).
    expect(screen.getByText(enMessages.viewer.steps.preview)).toBeInTheDocument();
    // Statuses with nothing in them are not printed as zeroes, and the ones that are print the word
    // rather than the enum.
    const markdown = screen.getByText(enMessages.viewer.steps.markdown).closest('tr');
    if (!(markdown instanceof HTMLElement)) throw new Error('expected the markdown step row');
    // The statuses are the columns now, so a step that has none of one leaves that cell empty —
    // which is what makes "готово" land in the same place on every line (docs/11 §11.13).
    const links = within(markdown).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/documents?step=markdown&stepStatus=DONE',
    ]);
  });

  it('shows what the bucket holds, scaled to something readable', async () => {
    renderWithProviders(<AdminQueueScreen />);

    expect(await screen.findByText('34')).toBeInTheDocument();
    // 1_932_735_283 bytes is 1.8 GB — printed in the unit a human reads, not in bytes.
    expect(screen.getByText('1.8 GB')).toBeInTheDocument();
    expect(screen.getByText(enMessages.admin.queue.storage.objects)).toBeInTheDocument();
  });

  it('says the bucket has not been measured instead of showing a zero', async () => {
    server.use(
      http.get('/api/admin/queue/overview', () =>
        HttpResponse.json(envelope({ ...overview, storage: null })),
      ),
    );

    renderWithProviders(<AdminQueueScreen />);

    expect(await screen.findByText(enMessages.admin.queue.storage.pending)).toBeInTheDocument();
  });

  it('lists a failure with its payload and retry count', async () => {
    renderWithProviders(<AdminQueueScreen />);

    const payload = await screen.findByText(/documentId=bbbbbbbb/);
    const row = payload.closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('expected a failures row');
    expect(within(row).getByText('document-process')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('keeps the error out of the row until it is asked for', async () => {
    renderWithProviders(<AdminQueueScreen />);
    await screen.findByText(/documentId=bbbbbbbb/);

    // A wall of text does not belong in a table cell (docs/11 §11.13).
    expect(screen.queryByText(/tesseract crashed/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /expand/i }));

    expect(await screen.findByText(/tesseract crashed/)).toBeInTheDocument();
  });

  it('retries a job and reports it', async () => {
    let retried: string | null = null;
    server.use(
      http.post('/api/admin/queue/failures/:jobId/retry', ({ params }) => {
        retried = String(params.jobId);
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.queue.actions.retry }),
    );

    await waitFor(() => expect(retried).toBe(JOB_ID));
    expect(await screen.findByText(enMessages.admin.queue.retried)).toBeInTheDocument();
  });

  it('surfaces a failed retry instead of pretending it worked', async () => {
    server.use(
      http.post('/api/admin/queue/failures/:jobId/retry', () =>
        HttpResponse.json(errorEnvelope('NOT_FOUND'), { status: 404 }),
      ),
    );

    renderWithProviders(<AdminQueueScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.queue.actions.retry }),
    );

    expect(await screen.findByText(enMessages.errors.codes.NOT_FOUND)).toBeInTheDocument();
  });

  it('names the stage in words and keeps the queue name beside it', async () => {
    renderWithProviders(<AdminQueueScreen />);

    // The technical name is what the failed-jobs table and the container's own logs say, so it
    // stays — but it is not what somebody comes to this page to read (docs/11 §11.13).
    expect(
      await screen.findByText(enMessages.admin.queue.names['document-process']),
    ).toBeInTheDocument();
    expect(screen.getAllByText('document-process').length).toBeGreaterThan(0);
    expect(screen.getByText(enMessages.admin.queue.hints['document-process'])).toBeInTheDocument();
  });

  it('says what the switch in the corner does, in words', async () => {
    renderWithProviders(<AdminQueueScreen />);

    // 🔒 A switch with nothing beside it is a switch nobody can read, and "what does this checkbox
    // do" is a question the screen should never make somebody ask (docs/11 §11.14).
    await waitFor(() =>
      expect(screen.getAllByText(enMessages.admin.queue.pause.title).length).toBe(5),
    );
  });

  it('runs a whole step, and the whole pipeline, without naming a status', async () => {
    const asked: unknown[] = [];
    server.use(
      http.post('/api/admin/queue/reprocess', async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json(envelope({ enqueued: 12 }));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    const preview = (await screen.findByText(enMessages.viewer.steps.preview)).closest('tr');
    if (!(preview instanceof HTMLElement)) throw new Error('expected the preview step row');

    // A step, whatever state its documents are in.
    await userEvent.click(
      within(preview).getByRole('button', { name: enMessages.admin.queue.actions.runStep }),
    );
    await waitFor(() => expect(asked).toContainEqual({ step: 'preview' }));

    // And the whole pipeline of every document — a different question from a bigger step, which is
    // why it sits at the top of the block rather than beside one (docs/11 §11.13).
    await userEvent.click(
      screen.getByRole('button', { name: enMessages.admin.queue.actions.runAll }),
    );
    await waitFor(() => expect(asked).toContainEqual({}));
  });

  it('makes every counter a way to the documents behind it', async () => {
    renderWithProviders(<AdminQueueScreen />);

    const preview = (await screen.findByText(enMessages.viewer.steps.preview)).closest('tr');
    if (!(preview instanceof HTMLElement)) throw new Error('expected the preview step row');

    // The point of "2 failed previews" is the two documents (docs/11 §11.13), and both halves of
    // the question travel: the API refuses one without the other.
    expect(within(preview).getByRole('link', { name: '2' })).toHaveAttribute(
      'href',
      '/documents?step=preview&stepStatus=FAILED',
    );
    expect(within(preview).getByRole('link', { name: '10' })).toHaveAttribute(
      'href',
      '/documents?step=preview&stepStatus=DONE',
    );
  });

  it('runs a failed step again and says how many it took', async () => {
    let asked: unknown = null;
    server.use(
      http.post('/api/admin/queue/reprocess', async ({ request }) => {
        asked = await request.json();
        return HttpResponse.json(envelope({ enqueued: 2 }));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    const preview = (await screen.findByText(enMessages.viewer.steps.preview)).closest('tr');
    if (!(preview instanceof HTMLElement)) throw new Error('expected the preview step row');

    // 🔒 Every status carries the action now, not only the ones that look broken: a step is re-run
    // because something about it changed, and by then the documents that need redoing are the ones
    // marked DONE (docs/11 §11.13). Preview has failures and successes, so there are two — the
    // first belongs to the first status printed.
    const buttons = within(preview).getAllByRole('button', {
      name: enMessages.admin.queue.actions.runAgain,
    });
    expect(buttons.length).toBe(2);
    const failed = buttons[1];
    if (failed === undefined) throw new Error('expected a button beside the failed count');
    await userEvent.click(failed);

    await waitFor(() => expect(asked).toEqual({ step: 'preview', status: 'FAILED' }));
    // The count is the whole point of the answer: five hundred documents were not opened by hand.
    expect(await screen.findByText('2 documents re-enqueued')).toBeInTheDocument();
  });

  it('pauses one queue without stopping the instance, and labels it beside its depth', async () => {
    let patched: unknown = null;
    let state = { ...settings };
    server.use(
      http.get('/api/admin/queue/settings', () => HttpResponse.json(envelope(state))),
      http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
      http.patch('/api/admin/queue/settings', async ({ request }) => {
        patched = await request.json();
        state = { ...settings, paused: ['document-process'] };
        return HttpResponse.json(envelope(state));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    const pause = await screen.findByRole('switch', { name: 'Pause document-process' });
    await waitFor(() => expect(pause).toBeEnabled());
    await userEvent.click(pause);

    // The settings are sent whole (docs/07 §7.3): pausing must not quietly reset the throughput.
    await waitFor(() =>
      expect(patched).toEqual({
        concurrency: settings.concurrency,
        unitConcurrency: settings.unitConcurrency,
        paused: ['document-process'],
      }),
    );

    // A growing queue must never be mistaken for a stuck one (docs/11 §11.13).
    const card = pause.closest('.ant-card');
    if (!(card instanceof HTMLElement)) throw new Error('expected the queue card');
    expect(await within(card).findByText(enMessages.admin.queue.pause.tag)).toBeInTheDocument();
  });

  // The refresh is a real 5 s interval (docs/11 §11.13), so this waits it out rather than faking
  // timers, which react-query and antd both interact with badly.
  it('polls while live and stops once paused', { timeout: 30_000 }, async () => {
    let calls = 0;
    server.use(
      http.get('/api/admin/queue/overview', () => {
        calls += 1;
        return HttpResponse.json(envelope(overview));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    await screen.findByText(enMessages.admin.queue.pipeline.title);
    await waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 15_000 });

    // Pausing is what makes a long error readable while the queue keeps moving.
    await userEvent.click(screen.getByRole('switch', { name: enMessages.admin.queue.autoRefresh }));
    const afterPause = calls;
    await new Promise((resolve) => setTimeout(resolve, 8000));

    expect(calls).toBe(afterPause);
  });
});
