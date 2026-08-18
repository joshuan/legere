import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueSettingsDto, ServiceHealthDto } from '../../../shared/contracts/queue';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminQueueScreen } from './admin-queue-screen';

// The screen puts the open tab in the address (docs/11 §11.13), so it needs a router.
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

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
  // What the vectorization step has actually produced (docs/03 §3.3.11): one model, which is what a
  // healthy archive looks like.
  vectors: { chunks: 240, byModel: [{ model: 'bge-m3', chunks: 240 }] },
  // What each gate is doing this instant (docs/05 §5.4b): Stirling throttled to one with two waiting,
  // and everything else ungated — which is what an instance nobody has gated answers with.
  gates: [
    { service: 'stirling', inFlight: 1, waiting: 2, longestWaitMs: 7_400, gated: true },
    { service: 'docling', inFlight: 0, waiting: 0, longestWaitMs: 0, gated: false },
    { service: 'classifier', inFlight: 0, waiting: 0, longestWaitMs: 0, gated: false },
    { service: 'transcriber', inFlight: 0, waiting: 0, longestWaitMs: 0, gated: false },
    { service: 'embeddings', inFlight: 0, waiting: 0, longestWaitMs: 0, gated: false },
  ],
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
  pausedSteps: [],
  // Every gate off, which is what an instance that has never been gated answers with
  // (docs/05 §5.4b).
  services: {
    stirling: { concurrency: 0, cooldownSeconds: 0 },
    docling: { concurrency: 0, cooldownSeconds: 0 },
    classifier: { concurrency: 0, cooldownSeconds: 0 },
    transcriber: { concurrency: 0, cooldownSeconds: 0 },
    embeddings: { concurrency: 0, cooldownSeconds: 0 },
  },
};

// Where each external service is and whether it answered (docs/05 §5.4c) — one of each state worth
// drawing differently: up, never configured, refusing the key, and not answering at all.
const CHECKED_AT = '2026-01-02T10:05:00.000Z';
const servicesHealth: ServiceHealthDto[] = [
  {
    service: 'stirling',
    url: 'http://stirling:8080',
    status: 'UP',
    httpStatus: 200,
    latencyMs: 12,
    checkedAt: CHECKED_AT,
    detail: null,
  },
  {
    service: 'docling',
    url: '',
    status: 'NOT_CONFIGURED',
    httpStatus: null,
    latencyMs: null,
    checkedAt: CHECKED_AT,
    detail: null,
  },
  {
    service: 'classifier',
    url: 'http://ollama:11434/v1',
    status: 'UNAUTHORIZED',
    httpStatus: 401,
    latencyMs: 30,
    checkedAt: CHECKED_AT,
    detail: null,
  },
  {
    service: 'transcriber',
    url: 'http://whisper:9000/v1',
    status: 'DOWN',
    httpStatus: null,
    latencyMs: 5000,
    checkedAt: CHECKED_AT,
    detail: 'getaddrinfo ENOTFOUND whisper',
  },
  {
    service: 'embeddings',
    url: 'http://ollama:11434/v1',
    status: 'UP',
    httpStatus: 200,
    latencyMs: 8,
    checkedAt: CHECKED_AT,
    detail: null,
  },
];

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
    http.get('/api/admin/queue/services', () =>
      HttpResponse.json(envelope({ services: servicesHealth })),
    ),
    // Every tab reads these two: the switches and the knobs come from the settings, and the summary
    // line is a reading of them. A test that cares about a particular answer overrides them.
    http.get('/api/admin/queue/settings', () => HttpResponse.json(envelope(settings))),
    http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminQueueScreen', () => {
  it('shows one row per stage with its depths, quiet stages included', async () => {
    renderWithProviders(<AdminQueueScreen />);

    // One row per stage rather than a card per stage: five stages read as five lines, and each
    // column heading is written once (docs/11 §11.13).
    expect(await screen.findByText(enMessages.admin.queue.failedRecent)).toBeInTheDocument();
    const ingest = screen.getByText('file-ingest').closest('tr');
    if (!(ingest instanceof HTMLElement)) throw new Error('expected the file-ingest row');
    expect(within(ingest).getByText('3')).toBeInTheDocument();
    expect(screen.getAllByText('document-process').length).toBeGreaterThan(0);
    expect(screen.getByText('maintenance')).toBeInTheDocument();
    // A stage with nothing wrong prints no zero in the failures column.
    const scan = screen.getByText('library-scan').closest('tr');
    if (!(scan instanceof HTMLElement)) throw new Error('expected the library-scan row');
    expect(within(scan).queryByText('4')).not.toBeInTheDocument();
  });

  it('shows where the documents stand in the pipeline', async () => {
    renderWithProviders(<AdminQueueScreen tab="pipeline" />);

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

  // What the step produced, on the row that produced it (docs/03 §3.3.11): a vectorization reading
  // DONE over an empty table was the one failure this screen could not show.
  it('says how many vectors the archive holds, and which model made them', async () => {
    renderWithProviders(<AdminQueueScreen tab="pipeline" />);

    const row = (await screen.findByText(enMessages.viewer.steps.vectorization)).closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('expected the vectorization row');
    expect(
      within(row).getByText((content) => content.replace(/\s+/g, ' ') === '240 chunks · bge-m3'),
    ).toBeInTheDocument();
  });

  // 🔒 Two models in one table is a search whose distances mean nothing (docs/04 §4.5), and it has
  // no other symptom — so it is a warning on the row and not a footnote.
  it('warns when the archive holds two models at once', async () => {
    server.use(
      http.get('/api/admin/queue/overview', () =>
        HttpResponse.json(
          envelope({
            ...overview,
            vectors: {
              chunks: 300,
              byModel: [
                { model: 'bge-m3', chunks: 240 },
                { model: 'text-embedding-3-small', chunks: 60 },
              ],
            },
          }),
        ),
      ),
    );
    renderWithProviders(<AdminQueueScreen tab="pipeline" />);

    const row = (await screen.findByText(enMessages.viewer.steps.vectorization)).closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('expected the vectorization row');
    expect(await within(row).findByText(/bge-m3, text-embedding-3-small/)).toBeInTheDocument();
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
    renderWithProviders(<AdminQueueScreen tab="failures" />);

    const payload = await screen.findByText(/documentId=bbbbbbbb/);
    const row = payload.closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('expected a failures row');
    expect(within(row).getByText('document-process')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it('keeps the error out of the row until it is asked for', async () => {
    renderWithProviders(<AdminQueueScreen tab="failures" />);
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

    renderWithProviders(<AdminQueueScreen tab="failures" />);
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

    renderWithProviders(<AdminQueueScreen tab="failures" />);
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

  it('says what the switch on a stage row does, in words', async () => {
    renderWithProviders(<AdminQueueScreen />);

    // 🔒 A switch with nothing beside it is a switch nobody can read, and "what does this checkbox
    // do" is a question the screen should never make somebody ask (docs/11 §11.14). The column is
    // headed once and every row's switch says which stage it belongs to.
    expect(await screen.findByText(enMessages.admin.queue.pause.title)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', {
        name: enMessages.admin.queue.pause.switch.replace('{queue}', 'document-process'),
      }),
    ).toBeInTheDocument();
  });

  it('runs a whole step, and the whole pipeline, without naming a status', async () => {
    const asked: unknown[] = [];
    server.use(
      http.post('/api/admin/queue/reprocess', async ({ request }) => {
        asked.push(await request.json());
        return HttpResponse.json(envelope({ enqueued: 12 }));
      }),
    );

    renderWithProviders(<AdminQueueScreen tab="pipeline" />);
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
    renderWithProviders(<AdminQueueScreen tab="pipeline" />);

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

    renderWithProviders(<AdminQueueScreen tab="pipeline" />);
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

    // The settings are sent whole (docs/07 §7.3): pausing must not quietly reset the throughput,
    // nor the gates in front of the external services.
    await waitFor(() =>
      expect(patched).toEqual({
        concurrency: settings.concurrency,
        unitConcurrency: settings.unitConcurrency,
        paused: ['document-process'],
        pausedSteps: [],
        services: settings.services,
      }),
    );

    // A growing queue must never be mistaken for a stuck one (docs/11 §11.13).
    const card = pause.closest('.ant-card');
    if (!(card instanceof HTMLElement)) throw new Error('expected the queue card');
    expect(await within(card).findByText(enMessages.admin.queue.pause.tag)).toBeInTheDocument();
  });

  // The finer switch, on the row where the step is already named (docs/11 §11.13, docs/05 §5.4d).
  describe('pausing one step of the pipeline', () => {
    const runSwitch = (step: string): Promise<HTMLElement> =>
      screen.findByRole('switch', {
        name: enMessages.admin.queue.pause.stepSwitch.replace('{step}', step),
      });

    it('holds a step without touching the queues or the gates beside it', async () => {
      let patched: unknown = null;
      let state = { ...settings };
      server.use(
        http.get('/api/admin/queue/settings', () => HttpResponse.json(envelope(state))),
        http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
        http.patch('/api/admin/queue/settings', async ({ request }) => {
          patched = await request.json();
          state = { ...settings, pausedSteps: ['analysis'] };
          return HttpResponse.json(envelope(state));
        }),
      );

      renderWithProviders(<AdminQueueScreen tab="pipeline" />);
      const analysis = await runSwitch(enMessages.viewer.steps.analysis);
      await waitFor(() => expect(analysis).toBeEnabled());
      await userEvent.click(analysis);

      // Sent whole, like every other save on this page: holding a step must not reset a
      // concurrency, a gate, or a queue somebody paused.
      await waitFor(() =>
        expect(patched).toEqual({
          concurrency: settings.concurrency,
          unitConcurrency: settings.unitConcurrency,
          paused: [],
          pausedSteps: ['analysis'],
          services: settings.services,
        }),
      );
    });

    it('tags a held step and offers it no way to be run again', async () => {
      server.use(
        http.get('/api/admin/queue/settings', () =>
          HttpResponse.json(envelope({ ...settings, pausedSteps: ['analysis'] })),
        ),
        http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
      );

      renderWithProviders(<AdminQueueScreen tab="pipeline" />);

      const analysis = (await runSwitch(enMessages.viewer.steps.analysis)).closest('tr');
      if (!(analysis instanceof HTMLElement)) throw new Error('expected the analysis row');
      expect(within(analysis).getByText(enMessages.admin.queue.pause.tag)).toBeInTheDocument();
      // 🔒 Neither the per-step icon nor the one beside its count: the server refuses a re-run of a
      // held step, and an icon that answers 409 is worse than no icon (docs/11 §11.13).
      expect(
        within(analysis).queryByRole('button', { name: enMessages.admin.queue.actions.runStep }),
      ).not.toBeInTheDocument();
      expect(
        within(analysis).queryByRole('button', { name: enMessages.admin.queue.actions.runAgain }),
      ).not.toBeInTheDocument();
      // The counter itself stays a link: the twelve documents behind it are still the point.
      expect(within(analysis).getAllByRole('link')).toHaveLength(1);

      // A step that is not held keeps both.
      const preview = (await runSwitch(enMessages.viewer.steps.preview)).closest('tr');
      if (!(preview instanceof HTMLElement)) throw new Error('expected the preview row');
      expect(
        within(preview).getByRole('button', { name: enMessages.admin.queue.actions.runStep }),
      ).toBeInTheDocument();
    });
  });

  // A gate per external service, in one block of its own below the stages: a service is not a
  // stage, and Stirling serves two of them (docs/11 §11.13, docs/05 §5.4b).
  describe('the external services block', () => {
    let patched: unknown = null;

    beforeEach(() => {
      patched = null;
      server.use(
        http.get('/api/admin/queue/settings', () => HttpResponse.json(envelope(settings))),
        http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
        http.patch('/api/admin/queue/settings', async ({ request }) => {
          patched = await request.json();
          return HttpResponse.json(envelope(settings));
        }),
      );
    });

    // Looked up again on every turn rather than once: the block is drawn before the queues are,
    // and the arrival of the overview moves it down the page — which replaces the node a first
    // lookup would have held on to.
    function servicesCard(): Promise<HTMLElement> {
      return waitFor(
        () => {
          const title = screen.getByText(enMessages.admin.queue.services.title);
          const card = title.closest('.ant-card');
          if (!(card instanceof HTMLElement)) throw new Error('expected the services card');
          if (within(card).queryAllByRole('spinbutton').length === 0) {
            throw new Error('the gates have not been drawn yet');
          }
          return card;
        },
        { timeout: 5000 },
      );
    }

    it('names every service twice and says which work it serves', async () => {
      renderWithProviders(<AdminQueueScreen tab="services" />);
      const card = await servicesCard();

      for (const service of ['stirling', 'docling', 'classifier', 'transcriber', 'embeddings']) {
        // What it is called in the settings, beside what it is (docs/11 §11.13).
        expect(within(card).getByText(service)).toBeInTheDocument();
      }
      expect(
        within(card).getByText(enMessages.admin.queue.services.names.classifier),
      ).toBeInTheDocument();
      // A line for a reader who has never opened docs/05 §5.4b.
      expect(
        within(card).getByText(enMessages.admin.queue.services.hints.docling),
      ).toBeInTheDocument();
      // A block of zeroes is an instance whose services are not gated at all, and it says so
      // plainly rather than looking misconfigured.
      expect(within(card).getAllByRole('spinbutton')).toHaveLength(10);
      expect(
        within(card)
          .getAllByRole('spinbutton')
          .every((input) => input.getAttribute('value') === '0'),
      ).toBe(true);
    });

    it('says where each service is, and says so in words where there is no address', async () => {
      renderWithProviders(<AdminQueueScreen tab="services" />);
      const card = await servicesCard();

      expect(await within(card).findByText('http://stirling:8080')).toBeInTheDocument();
      // One address, two services behind it — the analyst falling back to the embeddings endpoint
      // is a configuration this panel has to be able to draw (docs/12 §12.4).
      expect(within(card).getAllByText('http://ollama:11434/v1')).toHaveLength(2);
      // 🔒 An instance without Docling is a supported instance, and it says so rather than leaving
      // a gap that reads as a bug (docs/11 §11.13).
      expect(
        within(card).getByText(enMessages.admin.queue.services.addressUnset),
      ).toBeInTheDocument();
    });

    it('says which services answered and which did not', async () => {
      renderWithProviders(<AdminQueueScreen tab="services" />);
      const card = await servicesCard();

      expect(
        await within(card).findAllByText(enMessages.admin.queue.services.health.UP),
      ).toHaveLength(2);
      expect(
        within(card).getByText(enMessages.admin.queue.services.health.UNAUTHORIZED),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(enMessages.admin.queue.services.health.DOWN),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(enMessages.admin.queue.services.health.NOT_CONFIGURED),
      ).toBeInTheDocument();

      // The state of a service sits on the row of that service, not somewhere near it.
      const transcriber = within(card).getByText('transcriber').closest('tr');
      if (!(transcriber instanceof HTMLElement)) throw new Error('expected the transcriber row');
      expect(
        within(transcriber).getByText(enMessages.admin.queue.services.health.DOWN),
      ).toBeInTheDocument();
    });

    it('probes again when asked, without touching the gates', async () => {
      let probes = 0;
      server.use(
        http.get('/api/admin/queue/services', () => {
          probes += 1;
          return HttpResponse.json(envelope({ services: servicesHealth }));
        }),
      );

      renderWithProviders(<AdminQueueScreen tab="services" />);
      const card = await servicesCard();
      await waitFor(() => expect(probes).toBe(1));

      await userEvent.click(
        within(card).getByRole('button', { name: enMessages.admin.queue.services.check }),
      );

      await waitFor(() => expect(probes).toBe(2));
      // 🔒 The gates are untouched by a probe: nothing was saved, and the save is still dark.
      expect(patched).toBeNull();
      expect(
        within(card).getByRole('button', { name: enMessages.common.actions.save }),
      ).toBeDisabled();
    });

    // 🔒 A page that waits for a dead container to time out is unusable at the moment it is needed.
    it('draws and saves the gates while the probes are still out', async () => {
      server.use(
        // A probe that never comes back — the dead container, exactly as it behaves.
        http.get('/api/admin/queue/services', () => new Promise<Response>(() => undefined)),
      );

      renderWithProviders(<AdminQueueScreen tab="services" />);
      const card = await servicesCard();

      const cooldown = within(card).getByRole('spinbutton', {
        name: 'Pause after each call to Stirling-PDF, seconds',
      });
      await userEvent.clear(cooldown);
      await userEvent.type(cooldown, '30');
      const save = within(card).getByRole('button', { name: enMessages.common.actions.save });
      await waitFor(() => expect(save).toBeEnabled());
      await userEvent.click(save);

      await waitFor(() => expect(patched).not.toBeNull());
    });

    it('offers the save only once a gate differs, and sends the settings whole', async () => {
      renderWithProviders(<AdminQueueScreen tab="services" />);
      const card = await servicesCard();
      const save = within(card).getByRole('button', { name: enMessages.common.actions.save });
      await waitFor(() => expect(save).toBeDisabled());

      const cooldown = within(card).getByRole('spinbutton', {
        name: 'Pause after each call to Stirling-PDF, seconds',
      });
      await userEvent.clear(cooldown);
      await userEvent.type(cooldown, '30');

      await waitFor(() => expect(save).toBeEnabled());
      await userEvent.click(save);

      // Sent whole (docs/07 §7.3), gates included: nothing else on the page is quietly reset.
      await waitFor(() =>
        expect(patched).toEqual({
          concurrency: settings.concurrency,
          unitConcurrency: settings.unitConcurrency,
          paused: [],
          pausedSteps: [],
          services: { ...settings.services, stirling: { concurrency: 0, cooldownSeconds: 30 } },
        }),
      );
    });
  });

  // The refresh is a real 5 s interval (docs/11 §11.13), so this waits it out rather than faking
  // timers, which react-query and antd both interact with badly.
  // Four tabs, one question each, and the open one is part of the address (docs/11 §11.13).
  describe('the tabs', () => {
    it('draws the tab it is on and none of the others', async () => {
      renderWithProviders(<AdminQueueScreen />);

      // Overview: the stages and the bucket, and not the step table, the gates or the failures.
      // Scoped to the open panel, because the tab strip names all four whichever one is open.
      expect(await screen.findByText(enMessages.admin.queue.stages.title)).toBeInTheDocument();
      const panel = within(screen.getByRole('tabpanel'));
      expect(panel.getByText(enMessages.admin.queue.storage.title)).toBeInTheDocument();
      expect(panel.queryByText(enMessages.admin.queue.pipeline.title)).not.toBeInTheDocument();
      expect(panel.queryByText(enMessages.admin.queue.services.title)).not.toBeInTheDocument();
      expect(panel.queryByText(enMessages.admin.queue.failures.title)).not.toBeInTheDocument();
    });

    it('puts the tab in the address on the press, without waiting for the router', async () => {
      renderWithProviders(<AdminQueueScreen />);
      await screen.findByText(enMessages.admin.queue.stages.title);

      await userEvent.click(
        screen.getByRole('tab', { name: enMessages.admin.queue.tabs.services }),
      );

      // 🔒 Drawn at once — the press is not waiting on a navigation — and the address follows it.
      expect(await screen.findByText(enMessages.admin.queue.services.title)).toBeInTheDocument();
      expect(replace).toHaveBeenCalledWith('/admin/queue/services');
    });

    it('carries the failure count on the failures tab, from wherever the reader is', async () => {
      renderWithProviders(<AdminQueueScreen />);

      const failures = await screen.findByRole('tab', {
        name: new RegExp(enMessages.admin.queue.tabs.failures),
      });
      // The four of the fixture, so a failure is visible without opening the tab it lives on. It
      // arrives with the overview, hence the wait.
      await waitFor(() => expect(within(failures).getByText('4')).toBeInTheDocument());
    });
  });

  // One sentence naming what is not in order, over the rows that answer it (docs/11 §11.13).
  describe('the summary line', () => {
    it('names a held step, a silent service and the failures, each linking to its tab', async () => {
      server.use(
        http.get('/api/admin/queue/settings', () =>
          HttpResponse.json(envelope({ ...settings, pausedSteps: ['analysis'] })),
        ),
        http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
      );

      renderWithProviders(<AdminQueueScreen />);

      const held = await screen.findByText(
        enMessages.admin.queue.summary.pausedSteps.replace(
          '{steps}',
          enMessages.viewer.steps.analysis,
        ),
      );
      expect(held.closest('a')).toHaveAttribute('href', '/admin/queue/pipeline');
      // The transcriber is DOWN and the analyst refuses the key in the fixture; Docling is not
      // configured at all, which is not a fault and must not be named as one (docs/05 §5.4c).
      const silent = screen.getByText(/Not answering/);
      expect(silent.closest('a')).toHaveAttribute('href', '/admin/queue/services');
      expect(silent.textContent).not.toContain(enMessages.admin.queue.services.names.docling);
      const failed = screen.getByText(
        enMessages.admin.queue.summary.failures.replace('{count}', '4'),
      );
      expect(failed.closest('a')).toHaveAttribute('href', '/admin/queue/failures');
    });

    it('says so plainly when there is nothing to report', async () => {
      server.use(
        http.get('/api/admin/queue/overview', () =>
          HttpResponse.json(
            envelope({
              ...overview,
              queues: overview.queues.map((queue) => ({ ...queue, failedRecent: 0 })),
            }),
          ),
        ),
        http.get('/api/admin/queue/services', () =>
          HttpResponse.json(
            envelope({
              services: servicesHealth.map((health) => ({ ...health, status: 'UP' as const })),
            }),
          ),
        ),
      );

      renderWithProviders(<AdminQueueScreen />);

      // 🔒 An empty strip and a page that has not loaded are the same picture; one of them is worth
      // worrying about, so the quiet case is stated rather than left blank.
      expect(await screen.findByText(enMessages.admin.queue.summary.ok)).toBeInTheDocument();
    });
  });

  it('saves a stage concurrency from its own row', async () => {
    let patched: unknown = null;
    server.use(
      http.get('/api/admin/queue/settings', () => HttpResponse.json(envelope(settings))),
      http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
      http.patch('/api/admin/queue/settings', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope(settings));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    const input = await screen.findByRole('spinbutton', {
      name: enMessages.admin.queue.settings.concurrencyFor.replace(
        '{stage}',
        enMessages.admin.queue.names['document-process'],
      ),
    });
    // One press of the arrow: 2 → 3. Clearing first would take the field to its floor of 1 on the
    // way, and the number typed after that would land beside the 1 rather than replacing it.
    await userEvent.type(input, '{arrowup}');

    const save = screen.getAllByRole('button', { name: enMessages.common.actions.save })[0];
    if (save === undefined) throw new Error('expected the save button');
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    // Sent whole, gates and pauses included: one knob changing must not reset another (docs/07 §7.3).
    await waitFor(() =>
      expect(patched).toEqual({
        concurrency: { ...settings.concurrency, 'document-process': 3 },
        unitConcurrency: settings.unitConcurrency,
        paused: [],
        pausedSteps: [],
        services: settings.services,
      }),
    );
  });

  // 🔒 The numbers that make a gate legible (docs/05 §5.4b). Without them a throttle that is working
  // and a setting that never took look exactly alike, and an operator goes looking for a bug.
  describe('what a gate is doing', () => {
    it('reports the calls in flight and the queue behind them, on the service row', async () => {
      renderWithProviders(<AdminQueueScreen tab="services" />);

      const stirling = (
        await screen.findByText(enMessages.admin.queue.services.names.stirling)
      ).closest('tr');
      if (!(stirling instanceof HTMLElement)) throw new Error('expected the Stirling row');
      expect(
        within(stirling).getByText(
          enMessages.admin.queue.services.inFlight.replace('{count}', '1'),
        ),
      ).toBeInTheDocument();
      // Seconds, rounded down: 7 400 ms is "7 s" and never "8".
      expect(
        within(stirling).getByText(
          enMessages.admin.queue.services.waiting.replace('{count}', '2').replace('{seconds}', '7'),
        ),
      ).toBeInTheDocument();
    });

    it('says an ungated service is ungated rather than showing it idle', async () => {
      renderWithProviders(<AdminQueueScreen tab="services" />);

      const docling = (
        await screen.findByText(enMessages.admin.queue.services.names.docling)
      ).closest('tr');
      if (!(docling instanceof HTMLElement)) throw new Error('expected the Docling row');
      expect(
        within(docling).getByText(enMessages.admin.queue.services.ungated),
      ).toBeInTheDocument();
    });

    it('tags the step whose service has callers waiting, and only that step', async () => {
      renderWithProviders(<AdminQueueScreen tab="pipeline" />);

      // Stirling serves the canonical and the preview; the fixture has two waiting at it. Docling is
      // not configured here, so the extraction goes to Stirling too (docs/05 §5.5 step 3).
      const waiting = enMessages.admin.queue.pipeline.waitingFor
        .replace('{service}', enMessages.admin.queue.services.names.stirling)
        .replace('{count}', '2');
      await waitFor(() => expect(screen.getAllByText(waiting)).toHaveLength(3));

      // The analysis goes to the analyst, whose gate is off: nothing to say on that row.
      const analysis = screen.getByText(enMessages.viewer.steps.analysis).closest('tr');
      if (!(analysis instanceof HTMLElement)) throw new Error('expected the analysis row');
      expect(within(analysis).queryByText(waiting)).not.toBeInTheDocument();
    });
  });

  it('refreshes on its own and stops when told to', { timeout: 30_000 }, async () => {
    let calls = 0;
    server.use(
      http.get('/api/admin/queue/overview', () => {
        calls += 1;
        return HttpResponse.json(envelope(overview));
      }),
    );

    renderWithProviders(<AdminQueueScreen />);
    await screen.findByText(enMessages.admin.queue.stages.title);
    await waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 15_000 });

    // Stopping the refresh is what makes a long error readable while the queue keeps moving — and it
    // is not called a pause, because two switches on this screen stop real work (docs/11 §11.13).
    await userEvent.click(screen.getByRole('switch', { name: enMessages.admin.queue.autoRefresh }));
    const afterStopping = calls;
    await new Promise((resolve) => setTimeout(resolve, 8000));

    expect(calls).toBe(afterStopping);
  });
});
