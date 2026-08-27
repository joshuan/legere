import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ServiceUnavailableError } from '../../application/ports/service-unavailable';
import { ungatedServices } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
import { FixedClock } from '../../../../test/helpers/fakes';
import { loadConfig } from '../config/app-config';
import { AsyncLocalCallContext } from '../logging/async-call-context';
import { StirlingPdfToolbox } from './stirling-pdf-toolbox';

// What the container is asked to do, with the container itself mocked (the acceptance of M4.2:
// "integration-tested against the dev Stirling container, mocked otherwise"). The wire format is the
// contract — a wrong field name fails at runtime with a 400 nobody sees until a document is queued.
function toolbox(
  url = 'http://stirling:8080',
  gates: ServiceGates = new ServiceGates(new FixedClock()),
): StirlingPdfToolbox {
  return new StirlingPdfToolbox(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      STIRLING_URL: url,
    }),
    gates,
  );
}

type FetchSpy = MockInstance<typeof fetch>;

function mockStirling(response: Response): FetchSpy {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

function pdfResponse(body = 'pdf-bytes'): Response {
  return new Response(body, { headers: { 'content-type': 'application/pdf' } });
}

// The request as Stirling receives it: URL plus the multipart fields.
function sentRequest(spy: FetchSpy): { url: string; form: FormData } {
  const call = spy.mock.calls[0];
  const [url, init] = call ?? [];
  if (typeof url !== 'string') throw new Error('expected a string URL');
  const body = init instanceof Object && 'body' in init ? init.body : undefined;
  if (!(body instanceof FormData)) throw new Error('expected a multipart body');
  return { url, form: body };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StirlingPdfToolbox', () => {
  it('converts an office file under its own name, so LibreOffice picks the right filter', async () => {
    const spy = mockStirling(pdfResponse());

    const result = await toolbox().toPdf({
      body: Buffer.from('docx-bytes'),
      fileName: 'Q1 report.docx',
    });

    expect(result.toString()).toBe('pdf-bytes');
    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/convert/file/pdf');
    const file = form.get('fileInput');
    if (!(file instanceof File)) throw new Error('expected a file part');
    expect(file.name).toBe('Q1 report.docx');
    expect(await file.text()).toBe('docx-bytes');
  });

  it('asks for page 1 as a single JPEG, not a zip of pages', async () => {
    const spy = mockStirling(new Response('jpeg-bytes'));

    await toolbox().pdfPageJpg(Readable.from([Buffer.from('%PDF-')]));

    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/convert/pdf/img');
    expect(form.get('pageNumbers')).toBe('1');
    expect(form.get('imageFormat')).toBe('jpeg');
    expect(form.get('singleOrMultiple')).toBe('single');
    expect(form.get('dpi')).toBe('150');
  });

  it('renders at the requested resolution when one is given', async () => {
    const spy = mockStirling(new Response('jpeg-bytes'));

    await toolbox().pdfPageJpg(Buffer.from('%PDF-'), { dpi: 300 });

    expect(sentRequest(spy).form.get('dpi')).toBe('300');
  });

  it('sends every OCR language as its own field and forces a full pass', async () => {
    const spy = mockStirling(pdfResponse());

    await toolbox().ocrPdf(Buffer.from('%PDF-'), ['rus', 'eng']);

    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/misc/ocr-pdf');
    expect(form.getAll('languages')).toEqual(['rus', 'eng']);
    // A document reaches OCR only after being judged textless, so skipping pages that hold a few
    // stray characters would leave exactly the pages we came for unreadable (docs/05 §5.5 step 3).
    expect(form.get('ocrType')).toBe('force-ocr');
    expect(form.get('ocrRenderType')).toBe('sandwich');
  });

  it('merges images in the order given, one part per page', async () => {
    const spy = mockStirling(pdfResponse());

    await toolbox().imagesToPdf([
      { body: Buffer.from('first'), fileName: '1.jpg' },
      { body: Buffer.from('second'), fileName: '2.jpg' },
    ]);

    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/convert/img/pdf');
    const parts = form.getAll('fileInput');
    // 🔒 Page order is item order (docs/05 §5.6) — a reordered merge is a wrong document.
    expect(parts.map((part) => (part instanceof File ? part.name : ''))).toEqual([
      '1.jpg',
      '2.jpg',
    ]);
  });

  it('refuses to merge nothing rather than asking the container to', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(toolbox().imagesToPdf([])).rejects.toThrow(/at least one image/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('merges the parts of a document in the order they were handed over', async () => {
    const spy = mockStirling(pdfResponse('merged'));

    const merged = await toolbox().mergePdfs([Buffer.from('one'), Buffer.from('two')]);

    expect(merged.toString()).toBe('merged');
    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/general/merge-pdfs');
    // 🔒 Page order is position order (docs/05 §5.5 step 1); sorting by name or date would silently
    // rearrange somebody's document.
    expect(form.get('sortType')).toBe('orderProvided');
    const parts = form.getAll('fileInput');
    expect(parts.map((part) => (part instanceof File ? part.name : ''))).toEqual([
      'part-0000.pdf',
      'part-0001.pdf',
    ]);
    const first = parts[0];
    if (!(first instanceof File)) throw new Error('expected a file part');
    expect(await first.text()).toBe('one');
  });

  it('refuses to merge an empty list rather than asking the container to', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(toolbox().mergePdfs([])).rejects.toThrow(/at least one part/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stamps the title and the date the document carries', async () => {
    const spy = mockStirling(pdfResponse('stamped'));

    await toolbox().stampMetadata(Buffer.from('%PDF-'), {
      title: 'Lease agreement',
      date: new Date('2019-07-14T08:30:00.000Z'),
    });

    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/misc/update-metadata');
    expect(form.get('title')).toBe('Lease agreement');
    // The one date format the endpoint parses.
    expect(form.get('creationDate')).toBe('2019/07/14 08:30:00');
    // 🔒 Never deleteAll: the parts brought metadata of their own, and this pass adds rather than
    // erases (docs/05 §5.5 step 1).
    expect(form.get('deleteAll')).toBe('false');
  });

  it('stamps a title alone when the document has no date', async () => {
    const spy = mockStirling(pdfResponse('stamped'));

    await toolbox().stampMetadata(Buffer.from('%PDF-'), { title: 'Untitled', date: null });

    const { form } = sentRequest(spy);
    expect(form.get('title')).toBe('Untitled');
    expect(form.get('creationDate')).toBeNull();
  });

  it('drops the image placeholders the converter writes in place of pictures', async () => {
    // What Stirling really answers for a scanned page: a note about the image, not text from it.
    mockStirling(
      new Response(
        '<image redacted: 596x842px, 595x842pt, ~72dpi, JPG, DEVICE_RGB, 32bpp>\n\nInvoice',
        { headers: { 'content-type': 'text/markdown' } },
      ),
    );

    const markdown = await toolbox().pdfToMarkdown(Buffer.from('pdf'));

    // 🔒 Left in, those placeholders would pass the "has a text layer" threshold and a scan would
    // never reach OCR (docs/05 §5.5).
    expect(markdown).not.toContain('image redacted');
    expect(markdown).toContain('Invoice');
  });

  // 🔒 …and the pattern that drops them is bounded by what a placeholder looks like (docs/05 §5.4a).
  // `[^>]*` meant every `<image redacted:` with no `>` after it scanned to the end of the document:
  // measured, 5 000 of them took 191 ms, 20 000 took 3 s and 640 KB of them took 12 s of the one
  // process that also answers HTTP. The text is a page's own, off a PDF somebody uploaded.
  it('reads a document full of unterminated placeholders in milliseconds (🔒)', async () => {
    const bomb = '<image redacted:'.repeat(40_000);
    mockStirling(new Response(bomb, { headers: { 'content-type': 'text/markdown' } }));

    const started = performance.now();
    const markdown = await toolbox().pdfToMarkdown(Buffer.from('pdf'));

    expect(performance.now() - started).toBeLessThan(1000);
    // Nothing matched, because nothing was a placeholder: the text comes back as it arrived.
    expect(markdown).toContain('<image redacted:');
  });

  it('reads a megabyte-long table row without pinning the worker to a core (🔒)', async () => {
    // A line of Markdown derived from somebody's PDF: a pipe, a run of spaces, and one character
    // that is not separator punctuation. The pattern that stood here divided that run between two
    // quantifiers that both accept a space, every way there is (docs/05 §5.5).
    const rowOf = (spaces: number): string => `|${' '.repeat(spaces)}x`;
    const timeToRead = async (line: string): Promise<{ markdown: string; elapsed: number }> => {
      mockStirling(new Response(line, { headers: { 'content-type': 'text/markdown' } }));
      const started = performance.now();
      const markdown = await toolbox().pdfToMarkdown(Buffer.from('pdf'));
      return { markdown, elapsed: performance.now() - started };
    };

    // The small case first, and deliberately: the old pattern took 2.7 s over this one, so a
    // regression fails here in seconds instead of blocking the worker for the minutes the next line
    // would cost it.
    const small = await timeToRead(rowOf(64_000));
    expect(small.elapsed).toBeLessThan(500);

    const megabyte = await timeToRead(rowOf(1024 * 1024));
    // Not a separator row, so the text it holds survives — the row is unchanged, just cheap to test.
    expect(megabyte.markdown).toContain('x');
    expect(megabyte.elapsed).toBeLessThan(1_000);
  }, 20_000);

  it('reads the page count out of the analysis answer', async () => {
    mockStirling(Response.json({ pageCount: 7, encrypted: false }));

    expect(await toolbox().pdfPageCount(Buffer.from('%PDF-'))).toBe(7);
  });

  it('fails loudly on an answer it cannot read, instead of guessing a count', async () => {
    mockStirling(Response.json({ pages: 7 }));

    await expect(toolbox().pdfPageCount(Buffer.from('%PDF-'))).rejects.toThrow(
      /unreadable page count/,
    );
  });

  // Every call to the container is one unit of the `stirling` gate (docs/05 §5.4b) — the page
  // count included, which reads a small answer rather than a document and is a call all the same.
  it('asks the stirling gate before every call it makes', async () => {
    const gates = new ServiceGates(new FixedClock());
    const run = vi.spyOn(gates, 'run');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        typeof input === 'string' && input.includes('page-count')
          ? Response.json({ pageCount: 3 })
          : pdfResponse(),
      ),
    );
    const pdfs = toolbox('http://stirling:8080', gates);

    await pdfs.pdfPageJpg(Buffer.from('%PDF-'));
    expect(await pdfs.pdfPageCount(Buffer.from('%PDF-'))).toBe(3);

    expect(run.mock.calls.map(([service]) => service)).toEqual(['stirling', 'stirling']);
  });

  it("puts the container's own message into the error, so a failed job is diagnosable", async () => {
    mockStirling(new Response('Unsupported file type: .pages', { status: 422 }));

    await expect(
      toolbox().toPdf({ body: Buffer.from('x'), fileName: 'notes.pages' }),
    ).rejects.toThrow(/422.*Unsupported file type/s);
  });

  it('names the languages when the container has no data for them', async () => {
    mockStirling(
      new Response(
        '{"error":"Job failed: java.io.IOException: Invalid OCR languages format: none of the ' +
          'selected languages are valid"}',
        { status: 500 },
      ),
    );

    // 🔒 The request was not malformed — the recognizer simply never had Russian. The message has to
    // say which languages were asked for and where they come from, or the only clue is a Java stack
    // trace about a "format" (ADR-018).
    await expect(toolbox().ocrPdf(Buffer.from('%PDF-'), ['rus'])).rejects.toThrow(
      /no tesseract data for rus.*deploy\/stirling/s,
    );
  });

  it('carries the id of the step it is doing, so both logs name the same call', async () => {
    const spy = mockStirling(pdfResponse());
    const context = new AsyncLocalCallContext();

    await context.run('11111111-1111-4111-8111-111111111111', () =>
      toolbox().pdfPageJpg(Buffer.from('%PDF-')),
    );

    const [, init] = spy.mock.calls[0] ?? [];
    const headers = init instanceof Object && 'headers' in init ? init.headers : undefined;
    expect(headers).toEqual({ 'X-Request-Id': '11111111-1111-4111-8111-111111111111' });
  });

  it('sends no id outside a call, rather than inventing one', async () => {
    const spy = mockStirling(pdfResponse());

    await toolbox().pdfPageJpg(Buffer.from('%PDF-'));

    const [, init] = spy.mock.calls[0] ?? [];
    const headers = init instanceof Object && 'headers' in init ? init.headers : undefined;
    expect(headers).toEqual({});
  });

  it('classifies the transport failing as the service being away (docs/05 §5.4e)', async () => {
    // undici rejects every network-level failure this way; the typed error is what tells the step
    // runner to queue the step again instead of failing the document.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await expect(toolbox().pdfPageCount(Buffer.from('%PDF-'))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('classifies a 503 the same way — a proxy answering for a container that is not there', async () => {
    mockStirling(new Response('Service Unavailable', { status: 503 }));

    await expect(toolbox().pdfPageCount(Buffer.from('%PDF-'))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('tolerates a configured URL with a trailing slash', async () => {
    const spy = mockStirling(Response.json({ pageCount: 1 }));

    await toolbox('http://stirling:8080/').pdfPageCount(Buffer.from('%PDF-'));

    expect(sentRequest(spy).url).toBe('http://stirling:8080/api/v1/analysis/page-count');
  });

  // 🔒 Every call to the container is one unit at the `stirling` gate (docs/05 §5.4b) — every
  // method, not most of them. A new method that builds its request by hand and forgets the gate
  // would leave an operator's "at most one OCR at a time" quietly meaning nothing, and the only
  // place that shows is the container's own load. The gate itself is tested in service-gate.test.ts;
  // what is tested here is that this client goes through it.
  it('lets no two calls overlap while the gate admits one, whichever methods they are', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return Response.json({ pageCount: 3 });
    });

    const gates = new ServiceGates(new FixedClock());
    gates.configure({ ...ungatedServices(), stirling: { concurrency: 1, cooldownSeconds: 0 } });
    const pdfs = toolbox('http://stirling:8080', gates);
    const bytes = (): Buffer => Buffer.from('%PDF-');

    // Two documents' worth of work at once, which is what a `document-process` concurrency of two
    // produces, across the whole surface of the client.
    await Promise.all([
      pdfs.pdfPageCount(bytes()),
      pdfs.pdfPageJpg(bytes()),
      pdfs.ocrPdf(bytes(), ['eng']),
      pdfs.pdfToMarkdown(bytes()),
      pdfs.toPdf({ body: bytes(), fileName: 'a.docx' }),
      pdfs.imagesToPdf([{ body: bytes(), fileName: 'a.jpg' }]),
      pdfs.mergePdfs([bytes(), bytes()]),
      pdfs.rearrangePages(bytes(), [1, 0]),
      pdfs.scalePages(bytes(), { pageSize: 'A4', orientation: 'PORTRAIT' }),
      pdfs.stampMetadata(bytes(), { title: 'Invoice', date: null }),
    ]);

    expect(peak).toBe(1);
  });

  // The other half of the same question, so the check above cannot pass by measuring nothing.
  it('lets the width of the gate through: two at once when two are allowed', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return pdfResponse();
    });

    const gates = new ServiceGates(new FixedClock());
    gates.configure({ ...ungatedServices(), stirling: { concurrency: 2, cooldownSeconds: 0 } });
    const pdfs = toolbox('http://stirling:8080', gates);

    await Promise.all([
      pdfs.pdfPageJpg(Buffer.from('%PDF-')),
      pdfs.pdfPageJpg(Buffer.from('%PDF-')),
      pdfs.pdfPageJpg(Buffer.from('%PDF-')),
    ]);

    expect(peak).toBe(2);
  });
});
