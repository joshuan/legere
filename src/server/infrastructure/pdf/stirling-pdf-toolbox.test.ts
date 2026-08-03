import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadConfig } from '../config/app-config';
import { StirlingPdfToolbox } from './stirling-pdf-toolbox';

// What the container is asked to do, with the container itself mocked (the acceptance of M4.2:
// "integration-tested against the dev Stirling container, mocked otherwise"). The wire format is the
// contract — a wrong field name fails at runtime with a 400 nobody sees until a document is queued.
function toolbox(url = 'http://stirling:8080'): StirlingPdfToolbox {
  return new StirlingPdfToolbox(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      STIRLING_URL: url,
    }),
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

    const result = await toolbox().officeToPdf({
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

    await toolbox().pdfFirstPageJpg(Readable.from([Buffer.from('%PDF-')]));

    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://stirling:8080/api/v1/convert/pdf/img');
    expect(form.get('pageNumbers')).toBe('1');
    expect(form.get('imageFormat')).toBe('jpeg');
    expect(form.get('singleOrMultiple')).toBe('single');
    expect(form.get('dpi')).toBe('150');
  });

  it('renders at the requested resolution when one is given', async () => {
    const spy = mockStirling(new Response('jpeg-bytes'));

    await toolbox().pdfFirstPageJpg(Buffer.from('%PDF-'), { dpi: 300 });

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

  it("puts the container's own message into the error, so a failed job is diagnosable", async () => {
    mockStirling(new Response('Unsupported file type: .pages', { status: 422 }));

    await expect(
      toolbox().officeToPdf({ body: Buffer.from('x'), fileName: 'notes.pages' }),
    ).rejects.toThrow(/422.*Unsupported file type/s);
  });

  it('lets a transport failure through, so the job retries with backoff', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(toolbox().pdfPageCount(Buffer.from('%PDF-'))).rejects.toThrow('ECONNREFUSED');
  });

  it('tolerates a configured URL with a trailing slash', async () => {
    const spy = mockStirling(Response.json({ pageCount: 1 }));

    await toolbox('http://stirling:8080/').pdfPageCount(Buffer.from('%PDF-'));

    expect(sentRequest(spy).url).toBe('http://stirling:8080/api/v1/analysis/page-count');
  });
});
