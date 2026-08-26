import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { UploadQueueProvider, useUploadQueue, type UploadQueue } from './upload-queue';

const DOCUMENT_ID = 'aaaaaaaa-1111-4111-8111-000000000009';
const TARGET_ID = 'aaaaaaaa-2222-4222-8222-000000000002';

// What the API answers an upload with (docs/07 §7.3): the row the grid can show at once.
function listDto(id: string): Record<string, unknown> {
  return {
    id,
    title: 'Contract',
    fileCount: 1,
    primaryExt: 'pdf',
    sizeBytes: '2048',
    pageCount: 1,
    documentType: null,
    availability: 'AVAILABLE',
    processing: false,
    origin: 'MANAGED',
    hasPreview: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    documentDate: null,
    people: [],
    subjects: [],
    country: null,
    city: null,
    languages: [],
    extractedSummary: null,
  };
}

// What appending a file answers with: the whole document, because a composition change is never
// local (docs/05 §5.6).
function detailDto(id: string): Record<string, unknown> {
  return {
    ...listDto(id),
    auto: {},
    ocrUsed: false,
    description: null,
    pageFormat: 'AUTO',
    titleSource: 'NONE',
    typeSource: 'NONE',
    steps: {
      canonical: 'PENDING',
      preview: 'PENDING',
      markdown: 'PENDING',
      analysis: 'PENDING',
      fields: 'PENDING',
      vectorization: 'PENDING',
    },
    skipReasons: {},
    processingError: null,
    failedStep: null,
    // The document as the ordered list of pages it is (docs/03 §3.3.17); this one holds none, since
    // what the panel watches is the upload and not the composition.
    pages: [],
    files: [],
    createdBy: null,
    extracted: null,
  };
}

function file(name: string, bytes = 'hello'): File {
  return new File([bytes], name, { type: 'application/pdf' });
}

// The store has no UI of its own, so the test drives it through a probe: the handle for the calls,
// one line per row for what the panel would draw.
let queue: UploadQueue | null = null;
let client: QueryClient | null = null;

function Probe() {
  queue = useUploadQueue();
  client = useQueryClient();

  return (
    <ul>
      {queue.items.map((item, index) => (
        <li key={item.key} data-testid={`row-${index}`}>
          {`${item.fileName}|${item.status}|${item.resultDocumentId ?? '-'}|${item.error ?? '-'}`}
        </li>
      ))}
    </ul>
  );
}

function mount(): void {
  renderWithProviders(
    <UploadQueueProvider>
      <Probe />
    </UploadQueueProvider>,
  );
}

function send(files: File[], target?: { documentId: string }): void {
  act(() => {
    queue?.send(files, target);
  });
}

function rowText(index: number): string {
  return screen.getByTestId(`row-${index}`).textContent ?? '';
}

// The same client the provider refreshes through, watched from the probe.
function watchInvalidations() {
  if (client === null) throw new Error('the probe never rendered');
  return vi.spyOn(client, 'invalidateQueries');
}

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  queue = null;
  client = null;
  server.use(
    http.post('/api/documents', () =>
      HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true })),
    ),
    http.post('/api/documents/:id/files', ({ params }) =>
      HttpResponse.json(envelope(detailDto(String(params.id)))),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('the upload queue', () => {
  it('sends the chosen files one at a time, in the order they were chosen', async () => {
    const sent: string[] = [];
    let inFlight = 0;
    server.use(
      http.post('/api/documents', async ({ request }) => {
        inFlight += 1;
        // 🔒 A queue, not a fan-out: forty parallel uploads saturate the connection and arrive
        // interleaved (docs/11 §11.3).
        expect(inFlight).toBe(1);
        sent.push(decodeURIComponent(request.headers.get('x-legere-filename') ?? ''));
        await delay(10);
        inFlight -= 1;
        return HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true }));
      }),
    );

    mount();
    send([file('First.pdf'), file('Second.pdf'), file('Third.pdf')]);

    // On the list before a byte is sent, in the order they were chosen — the first one already on
    // its way, the rest waiting their turn.
    expect(rowText(0)).toContain('First.pdf|uploading');
    expect(rowText(1)).toContain('Second.pdf|waiting');
    expect(rowText(2)).toContain('Third.pdf|waiting');

    await waitFor(() => expect(sent).toEqual(['First.pdf', 'Second.pdf', 'Third.pdf']));
    await waitFor(() => expect(rowText(2)).toContain('Third.pdf|done'));
  });

  it('walks a row from waiting to uploading to done', async () => {
    server.use(
      http.post('/api/documents', async () => {
        await delay(30);
        return HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true }));
      }),
    );

    mount();
    send([file('First.pdf'), file('Slow.pdf')]);

    // A row exists for every file at once, before any of them has left the browser.
    expect(rowText(1)).toContain('Slow.pdf|waiting');
    await waitFor(() => expect(rowText(1)).toContain('Slow.pdf|uploading'));
    await waitFor(() => expect(rowText(1)).toContain(`Slow.pdf|done|${DOCUMENT_ID}`));
  });

  // Deduplication doing its job is not an error (ADR-009): the row points at the document that
  // already holds those bytes.
  it('marks a file the instance already had as a duplicate, naming the document that has it', async () => {
    server.use(
      http.post('/api/documents', () =>
        HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: false })),
      ),
    );

    mount();
    send([file('Twice.pdf')]);

    await waitFor(() => expect(rowText(0)).toBe(`Twice.pdf|duplicate|${DOCUMENT_ID}|-`));
  });

  it('marks only the file that failed and carries on with the rest', async () => {
    server.use(
      http.post('/api/documents', ({ request }) => {
        const name = decodeURIComponent(request.headers.get('x-legere-filename') ?? '');
        return name === 'Bad.pdf'
          ? HttpResponse.json(errorEnvelope('DOCUMENT_DUPLICATE'), { status: 409 })
          : HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true }));
      }),
    );

    mount();
    send([file('Bad.pdf'), file('Good.pdf')]);

    await waitFor(() => expect(rowText(0)).toContain('Bad.pdf|failed'));
    // In the reader's own words, by code — never the server's `message` (docs/10 §10.3).
    expect(rowText(0)).toContain(enMessages.errors.codes.DOCUMENT_DUPLICATE);
    await waitFor(() => expect(rowText(1)).toContain('Good.pdf|done'));
  });

  it('re-queues a failed file in place and keeps its position', async () => {
    let attempts = 0;
    server.use(
      http.post('/api/documents', () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(errorEnvelope('INTERNAL'), { status: 500 })
          : HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true }));
      }),
    );

    mount();
    send([file('Flaky.pdf'), file('Other.pdf')]);
    await waitFor(() => expect(rowText(0)).toContain('Flaky.pdf|failed'));

    const key = queue?.items[0]?.key ?? '';
    act(() => {
      queue?.retry(key);
    });

    // Same row, same place, nothing left of the attempt that failed.
    await waitFor(() => expect(rowText(0)).toBe(`Flaky.pdf|done|${DOCUMENT_ID}|-`));
    expect(rowText(1)).toContain('Other.pdf|done');
    expect(queue?.items[0]?.key).toBe(key);
  });

  it('re-queues every failed file at once', async () => {
    let failing = true;
    server.use(
      http.post('/api/documents', () =>
        failing
          ? HttpResponse.json(errorEnvelope('INTERNAL'), { status: 500 })
          : HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true })),
      ),
    );

    mount();
    send([file('One.pdf'), file('Two.pdf')]);
    await waitFor(() => expect(rowText(1)).toContain('Two.pdf|failed'));

    failing = false;
    act(() => {
      queue?.retryFailed();
    });

    await waitFor(() => expect(rowText(0)).toContain('One.pdf|done'));
    await waitFor(() => expect(rowText(1)).toContain('Two.pdf|done'));
  });

  it('empties the queue and stops the file in flight when it is cleared', async () => {
    server.use(
      http.post('/api/documents', async () => {
        await delay(2000);
        return HttpResponse.json(envelope({ document: listDto(DOCUMENT_ID), created: true }));
      }),
    );

    mount();
    send([file('Long.pdf'), file('Next.pdf')]);
    await waitFor(() => expect(rowText(0)).toContain('Long.pdf|uploading'));

    act(() => {
      queue?.clearAll();
    });

    expect(screen.queryByTestId('row-0')).toBeNull();
    // 🔒 Nothing lands afterwards: the abort must not write a failed row back into a queue that
    // somebody emptied on purpose.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('row-0')).toBeNull();
    expect(queue?.busy).toBe(false);
  });

  it('refreshes the grid as each file settles, not once at the end', async () => {
    mount();
    const invalidate = watchInvalidations();

    send([file('One.pdf'), file('Two.pdf')]);
    await waitFor(() => expect(rowText(1)).toContain('Two.pdf|done'));

    const listCalls = invalidate.mock.calls.filter(
      ([options]) => JSON.stringify(options?.queryKey) === JSON.stringify(['documents']),
    );
    expect(listCalls).toHaveLength(2);
  });

  it('appends to a document when one is named, and refreshes that document too', async () => {
    const targets: string[] = [];
    server.use(
      http.post('/api/documents/:id/files', ({ params }) => {
        targets.push(String(params.id));
        return HttpResponse.json(envelope(detailDto(String(params.id))));
      }),
    );

    mount();
    const invalidate = watchInvalidations();
    send([file('Page.pdf')], { documentId: TARGET_ID });

    await waitFor(() => expect(rowText(0)).toContain(`Page.pdf|done|${TARGET_ID}`));
    expect(targets).toEqual([TARGET_ID]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['document', TARGET_ID] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['documents'] });
  });

  it('is busy only while something is waiting or in flight', async () => {
    mount();
    expect(queue?.busy).toBe(false);

    send([file('One.pdf')]);
    expect(queue?.busy).toBe(true);

    await waitFor(() => expect(rowText(0)).toContain('One.pdf|done'));
    expect(queue?.busy).toBe(false);
  });
});
