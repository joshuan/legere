import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessingSnapshotResponse } from '../../../shared/contracts/processing';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminProcessingScreen } from './admin-queue-screen';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const JOB_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const JOB_ID_2 = 'cccccccc-3333-4333-8333-333333333333';
const CHECKED_AT = '2026-01-02T10:05:00.000Z';

const snapshot: ProcessingSnapshotResponse = {
  generatedAt: '2026-01-02T10:06:00.000Z',
  revision: 7,
  apply: {
    status: 'APPLIED_WITH_WARNINGS',
    desiredRevision: 7,
    appliedRevision: 7,
    lastAttemptAt: '2026-01-02T10:05:30.000Z',
    detail: 'one worker is still changing',
  },
  topology: {
    version: 1,
    queues: [
      {
        name: 'library-scan',
        kind: 'INGRESS',
        produces: ['file-ingest'],
        concurrencyConfigurable: true,
        policy: 'stately',
        expireInSeconds: 86_400,
      },
      {
        name: 'file-ingest',
        kind: 'INGRESS',
        produces: ['document-process'],
        concurrencyConfigurable: true,
        policy: 'standard',
        expireInSeconds: 3_600,
      },
      {
        name: 'document-process',
        kind: 'PIPELINE',
        produces: [],
        concurrencyConfigurable: true,
        policy: 'short',
        expireInSeconds: 3_600,
      },
      {
        name: 'maintenance',
        kind: 'HOUSEKEEPING',
        produces: [],
        concurrencyConfigurable: true,
        policy: 'standard',
        expireInSeconds: 3_600,
      },
    ],
    pipeline: {
      queue: 'document-process',
      steps: [
        { step: 'canonical', dependencies: [], resources: [] },
        {
          step: 'preview',
          dependencies: [{ step: 'canonical', kind: 'ARTIFACT', holdWhen: 'UPSTREAM_UNSETTLED' }],
          resources: [{ service: 'stirling', role: 'PRIMARY', when: 'ALWAYS' }],
        },
      ],
    },
    services: [{ service: 'stirling', steps: ['preview'], otherConsumers: ['file-ingest'] }],
  },
  queues: [
    {
      name: 'library-scan',
      control: {
        paused: { effective: false, default: false, source: 'DEFAULT' },
        concurrency: { effective: 1, default: 1, source: 'DEFAULT' },
      },
      runtime: {
        registered: true,
        appliedConcurrency: 1,
        queued: 0,
        active: 0,
        failedRecent: 0,
        oldestQueuedAt: null,
        lastCompletedAt: '2026-01-02T10:00:00.000Z',
        completedLastHour: 9,
      },
      blockers: [],
    },
    {
      name: 'file-ingest',
      control: {
        paused: { effective: false, default: false, source: 'DEFAULT' },
        concurrency: { effective: 4, default: 2, source: 'OVERRIDE' },
      },
      runtime: {
        registered: true,
        appliedConcurrency: 4,
        queued: 3,
        active: 1,
        failedRecent: 0,
        oldestQueuedAt: '2026-01-02T09:00:00.000Z',
        lastCompletedAt: '2026-01-02T10:04:00.000Z',
        completedLastHour: 7,
      },
      blockers: [],
    },
    {
      name: 'document-process',
      control: {
        paused: { effective: true, default: false, source: 'OVERRIDE' },
        concurrency: { effective: 2, default: 2, source: 'DEFAULT' },
      },
      runtime: {
        registered: false,
        appliedConcurrency: null,
        queued: 2,
        active: 0,
        failedRecent: 4,
        oldestQueuedAt: '2026-01-02T08:00:00.000Z',
        lastCompletedAt: null,
        completedLastHour: 0,
      },
      blockers: [{ kind: 'QUEUE_PAUSED', queue: 'document-process' }],
    },
  ],
  pipeline: {
    queue: 'document-process',
    unitConcurrency: { effective: 3, default: 2, source: 'OVERRIDE' },
    totalDocuments: 12,
    steps: [
      {
        step: 'canonical',
        control: { paused: { effective: false, default: false, source: 'DEFAULT' } },
        counts: { PENDING: 0, QUEUED: 0, RUNNING: 0, DONE: 12, FAILED: 0, SKIPPED: 0 },
        blockers: [{ kind: 'QUEUE_PAUSED', queue: 'document-process' }],
      },
      {
        step: 'preview',
        control: { paused: { effective: false, default: false, source: 'DEFAULT' } },
        counts: { PENDING: 1, QUEUED: 0, RUNNING: 0, DONE: 10, FAILED: 1, SKIPPED: 0 },
        blockers: [
          {
            kind: 'DEPENDENCY_PAUSED',
            step: 'preview',
            path: ['canonical', 'preview'],
            condition: 'UPSTREAM_UNSETTLED',
          },
        ],
      },
    ],
  },
  services: [
    {
      service: 'stirling',
      control: {
        concurrency: { effective: 1, default: 0, source: 'OVERRIDE' },
        cooldownSeconds: { effective: 2, default: 0, source: 'OVERRIDE' },
      },
      gate: {
        inFlight: 1,
        waiting: 2,
        longestWaitMs: 7_400,
        gated: true,
        throttledUntil: null,
      },
      health: {
        freshness: 'FRESH',
        value: {
          url: 'http://stirling:8080',
          status: 'UP',
          httpStatus: 200,
          latencyMs: 12,
          checkedAt: CHECKED_AT,
          detail: null,
        },
      },
    },
  ],
  vectors: { chunks: 20, byModel: [{ model: 'bge-m3', chunks: 20 }] },
  storage: null,
};

const commandResult = {
  revision: 8,
  changed: true,
  apply: {
    status: 'APPLIED',
    desiredRevision: 8,
    appliedRevision: 8,
    lastAttemptAt: '2026-01-02T10:07:00.000Z',
    detail: null,
  },
  controls: {
    revision: 8,
    queues: snapshot.queues.map((row) => ({
      name: row.name,
      paused: row.control.paused,
      concurrency: row.control.concurrency,
    })),
    pipeline: {
      unitConcurrency: snapshot.pipeline.unitConcurrency,
      steps: snapshot.pipeline.steps.map((row) => ({
        step: row.step,
        paused: row.control.paused,
      })),
    },
    services: snapshot.services.map((row) => ({
      service: row.service,
      concurrency: row.control.concurrency,
      cooldownSeconds: row.control.cooldownSeconds,
    })),
  },
  resumed: [],
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/admin/processing', () => HttpResponse.json(envelope(snapshot))),
    http.get('/api/admin/processing/failures', () =>
      HttpResponse.json(
        envelope({
          items: [
            {
              jobId: JOB_ID,
              queue: 'document-process',
              payload: { documentId: 'bbbbbbbb-2222-4222-8222-222222222222' },
              error: 'renderer failed',
              failedAt: CHECKED_AT,
              retryCount: 2,
            },
          ],
          nextCursor: null,
        }),
      ),
    ),
    http.get('/api/admin/queue/analysis', () => HttpResponse.json(envelope({ language: '' }))),
    http.post('/api/admin/processing/services/check', () =>
      HttpResponse.json(
        envelope({ services: snapshot.services.flatMap((row) => row.health.value ?? []) }),
      ),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminProcessingScreen', () => {
  it('renders apply state, queue liveness, resolved settings and server topology from one snapshot', async () => {
    renderWithProviders(<AdminProcessingScreen />);

    expect(
      await screen.findByText(enMessages.admin.queue.apply.APPLIED_WITH_WARNINGS),
    ).toBeInTheDocument();
    expect(screen.getByText(enMessages.admin.queue.topology.title)).toBeInTheDocument();
    expect(screen.getByText(/library-scan → file-ingest/)).toBeInTheDocument();
    expect(
      screen.getAllByText(enMessages.admin.queue.liveness.completedLastHour).length,
    ).toBeGreaterThan(0);
    const ingest = screen.getByText('file-ingest').closest('tr');
    if (!(ingest instanceof HTMLElement)) throw new Error('expected file-ingest row');
    expect(within(ingest).getByText('7')).toBeInTheDocument();
    expect(
      within(ingest).getByText(enMessages.admin.queue.settings.source.OVERRIDE),
    ).toBeInTheDocument();
    const processing = screen.getByText('document-process').closest('tr');
    if (!(processing instanceof HTMLElement)) throw new Error('expected document-process row');
    expect(
      within(processing).getByText(enMessages.admin.queue.runtime.unregistered),
    ).toBeInTheDocument();
    expect(within(processing).getByText(/short/)).toBeInTheDocument();
    expect(within(processing).getByText(/Queue paused/)).toBeInTheDocument();
  });

  it('keeps queue drafts per row and sends a scoped optimistic command', async () => {
    let sent: unknown = null;
    server.use(
      http.patch('/api/admin/processing/queues/file-ingest', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope(commandResult));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen />);

    const input = await screen.findByRole('spinbutton', {
      name: enMessages.admin.queue.settings.concurrencyFor.replace(
        '{stage}',
        enMessages.admin.queue.names['file-ingest'],
      ),
    });
    await user.clear(input);
    await user.type(input, '6');
    const row = input.closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('expected editable queue row');
    await user.click(within(row).getByRole('button', { name: enMessages.common.actions.save }));

    await waitFor(() => expect(sent).toEqual({ expectedRevision: 7, concurrency: 6 }));
    const other = screen.getByRole('spinbutton', {
      name: enMessages.admin.queue.settings.concurrencyFor.replace(
        '{stage}',
        enMessages.admin.queue.names['document-process'],
      ),
    });
    expect(other).toHaveValue('2');
  });

  it('refreshes evidence but preserves a row draft after a revision conflict', async () => {
    let attempts = 0;
    server.use(
      http.patch('/api/admin/processing/queues/file-ingest', () => {
        attempts += 1;
        return HttpResponse.json(errorEnvelope('PROCESSING_SETTINGS_CHANGED'), { status: 409 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen />);

    const input = await screen.findByRole('spinbutton', {
      name: enMessages.admin.queue.settings.concurrencyFor.replace(
        '{stage}',
        enMessages.admin.queue.names['file-ingest'],
      ),
    });
    await user.clear(input);
    await user.type(input, '6');
    const row = input.closest('tr');
    if (!(row instanceof HTMLElement)) throw new Error('expected editable queue row');
    await user.click(within(row).getByRole('button', { name: enMessages.common.actions.save }));

    await waitFor(() => expect(attempts).toBe(1));
    expect(input).toHaveValue('6');
    expect(within(row).getByRole('button', { name: enMessages.common.actions.save })).toBeEnabled();
  });

  it('uses topology for pipeline dependencies/resources and scopes step commands', async () => {
    let sent: unknown = null;
    server.use(
      http.patch('/api/admin/processing/pipeline/steps/preview', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope(commandResult));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen tab="pipeline" />);

    const preview = (await screen.findByText(enMessages.viewer.steps.preview)).closest('tr');
    if (!(preview instanceof HTMLElement)) throw new Error('expected preview row');
    expect(within(preview).getByText(/after Canonical PDF/)).toBeInTheDocument();
    expect(within(preview).getByText(/Stirling-PDF/)).toBeInTheDocument();
    await user.click(
      within(preview).getByRole('switch', {
        name: enMessages.admin.queue.pause.stepSwitch.replace(
          '{step}',
          enMessages.viewer.steps.preview,
        ),
      }),
    );
    await waitFor(() => expect(sent).toEqual({ expectedRevision: 7, paused: true }));
  });

  it('saves pipeline concurrency and reprocesses through scoped processing routes', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    server.use(
      http.patch('/api/admin/processing/pipeline', async ({ request }) => {
        requests.push({ path: 'pipeline', body: await request.json() });
        return HttpResponse.json(envelope(commandResult));
      }),
      http.post('/api/admin/processing/reprocess', async ({ request }) => {
        requests.push({ path: 'reprocess', body: await request.json() });
        return HttpResponse.json(envelope({ enqueued: 12 }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen tab="pipeline" />);

    const units = await screen.findByRole('spinbutton', {
      name: enMessages.admin.queue.settings.unitConcurrency,
    });
    await user.clear(units);
    await user.type(units, '4');
    const card = units.closest('.ant-card');
    if (!(card instanceof HTMLElement)) throw new Error('expected pipeline settings card');
    const [save] = within(card).getAllByRole('button', {
      name: enMessages.common.actions.save,
    });
    if (!(save instanceof HTMLElement)) throw new Error('expected pipeline save button');
    await user.click(save);
    await waitFor(() =>
      expect(requests).toContainEqual({
        path: 'pipeline',
        body: { expectedRevision: 7, unitConcurrency: 4 },
      }),
    );

    await user.click(screen.getByRole('button', { name: enMessages.admin.queue.actions.runAll }));
    await waitFor(() => expect(requests).toContainEqual({ path: 'reprocess', body: {} }));
  });

  it('saves one service row and explicitly checks services through processing endpoints', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    server.use(
      http.patch('/api/admin/processing/services/stirling', async ({ request }) => {
        requests.push({ path: 'save', body: await request.json() });
        return HttpResponse.json(envelope(commandResult));
      }),
      http.post('/api/admin/processing/services/check', () => {
        requests.push({ path: 'check', body: null });
        return HttpResponse.json(
          envelope({ services: snapshot.services.flatMap((row) => row.health.value ?? []) }),
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen tab="services" />);

    const service = (await screen.findByText('stirling')).closest('tr');
    if (!(service instanceof HTMLElement)) throw new Error('expected service row');
    expect(within(service).getByText(/Pipeline steps: Preview/)).toBeInTheDocument();
    expect(within(service).getByText(/Other consumers: file-ingest/)).toBeInTheDocument();
    const concurrency = within(service).getByRole('spinbutton', {
      name: enMessages.admin.queue.services.concurrencyFor.replace(
        '{service}',
        enMessages.admin.queue.services.names.stirling,
      ),
    });
    await user.clear(concurrency);
    await user.type(concurrency, '3');
    await user.click(within(service).getByRole('button', { name: enMessages.common.actions.save }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        path: 'save',
        body: { expectedRevision: 7, concurrency: 3, cooldownSeconds: 2 },
      }),
    );
    await user.click(screen.getByRole('button', { name: enMessages.admin.queue.services.check }));
    await waitFor(() => expect(requests).toContainEqual({ path: 'check', body: null }));
  });

  it('checks services on entry and uses the slower service cadence only on that tab', async () => {
    let checks = 0;
    const intervals = vi.spyOn(window, 'setInterval');
    server.use(
      http.post('/api/admin/processing/services/check', () => {
        checks += 1;
        return HttpResponse.json(
          envelope({ services: snapshot.services.flatMap((row) => row.health.value ?? []) }),
        );
      }),
    );
    const view = renderWithProviders(<AdminProcessingScreen tab="services" />);

    await waitFor(() => expect(checks).toBe(1));
    expect(intervals.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
    view.unmount();
    intervals.mockClear();
    checks = 0;

    renderWithProviders(<AdminProcessingScreen />);
    await screen.findByText(enMessages.admin.queue.stages.title);
    expect(checks).toBe(0);
    expect(intervals.mock.calls.some((call) => call[1] === 60_000)).toBe(false);
    intervals.mockRestore();
  });

  it('resets service overrides one field at a time', async () => {
    let sent: unknown = null;
    server.use(
      http.patch('/api/admin/processing/services/stirling', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope(commandResult));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen tab="services" />);

    const reset = await screen.findByRole('button', {
      name: enMessages.admin.queue.services.resetConcurrency,
    });
    await user.click(reset);
    await waitFor(() => expect(sent).toEqual({ expectedRevision: 7, concurrency: null }));
  });

  it('loads and retries failures through the processing namespace', async () => {
    let retried = '';
    server.use(
      http.post('/api/admin/processing/failures/:jobId/retry', ({ params }) => {
        retried = String(params.jobId);
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen tab="failures" />);

    await user.click(
      await screen.findByRole('button', { name: enMessages.admin.queue.actions.retry }),
    );
    await waitFor(() => expect(retried).toBe(JOB_ID));
  });

  it('continues the cursor-paginated failure history', async () => {
    const cursors: Array<string | null> = [];
    const secondDocumentId = 'dddddddd-4444-4444-8444-444444444444';
    server.use(
      http.get('/api/admin/processing/failures', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(
          envelope(
            cursor === null
              ? {
                  items: [
                    {
                      jobId: JOB_ID,
                      queue: 'document-process',
                      payload: { documentId: 'bbbbbbbb-2222-4222-8222-222222222222' },
                      error: 'first failure',
                      failedAt: CHECKED_AT,
                      retryCount: 2,
                    },
                  ],
                  nextCursor: CHECKED_AT,
                }
              : {
                  items: [
                    {
                      jobId: JOB_ID_2,
                      queue: 'document-process',
                      payload: { documentId: secondDocumentId },
                      error: 'second failure',
                      failedAt: '2026-01-02T10:04:00.000Z',
                      retryCount: 1,
                    },
                  ],
                  nextCursor: null,
                },
          ),
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen tab="failures" />);

    await user.click(
      await screen.findByRole('button', { name: enMessages.admin.queue.failures.more }),
    );

    expect(await screen.findByText(`documentId=${secondDocumentId}`)).toBeInTheDocument();
    expect(cursors).toEqual([null, CHECKED_AT]);
    expect(
      screen.queryByRole('button', { name: enMessages.admin.queue.failures.more }),
    ).not.toBeInTheDocument();
  });

  it('puts the selected tab into the new processing URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminProcessingScreen />);
    await screen.findByText(enMessages.admin.queue.stages.title);

    await user.click(screen.getByRole('tab', { name: enMessages.admin.queue.tabs.services }));
    expect(replace).toHaveBeenCalledWith('/admin/processing/services');
  });
});
