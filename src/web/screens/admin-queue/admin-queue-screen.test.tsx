import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
      { step: 'categorization', counts: { SKIPPED: 12, PENDING: 0, DONE: 0, FAILED: 0 } },
      { step: 'vectorization', counts: { SKIPPED: 12, PENDING: 0, DONE: 0, FAILED: 0 } },
    ],
  },
  storage: { objects: 34, bytes: '1932735283', measuredAt: '2026-01-02T09:00:00.000Z' },
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

    // One card per queue, including the quiet ones — five cards, five "failed" figures.
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
    expect(screen.getByText(enMessages.admin.queue.steps.preview)).toBeInTheDocument();
    // Statuses with nothing in them are not printed as zeroes.
    const markdown = screen.getByText(enMessages.admin.queue.steps.markdown).closest('.ant-card');
    if (!(markdown instanceof HTMLElement)) throw new Error('expected the markdown step card');
    expect(within(markdown).queryByText('PENDING')).not.toBeInTheDocument();
    expect(within(markdown).getByText('DONE')).toBeInTheDocument();
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
