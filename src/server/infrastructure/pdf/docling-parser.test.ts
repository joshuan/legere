import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadConfig } from '../config/app-config';
import { DoclingParser } from './docling-parser';

// The multipart body *is* the contract: Docling answers 200 with worse output when a field name is
// wrong, so a mistake here shows up as mangled text weeks later, not as an error. Same reasoning as
// the Stirling toolbox test next to this one.
function parser(overrides: Record<string, string> = {}): DoclingParser {
  return new DoclingParser(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      DOCLING_URL: 'http://docling:5001',
      ...overrides,
    }),
  );
}

type FetchSpy = MockInstance<typeof fetch>;

const TASK = 'task-1';

// fetch takes a string, a URL or a Request; the fake has to answer on all three the same way.
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

// Submit, poll, collect — the three calls a conversion makes (docs/05 §5.5). `polls` lets a test
// keep the task working for a while before it settles.
function answers(markdown: string | null, { polls = 1 } = {}): FetchSpy {
  let remaining = polls;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = urlOf(input);
    if (url.includes('/v1/convert')) {
      return Promise.resolve(Response.json({ task_id: TASK, task_status: 'pending' }));
    }
    if (url.includes('/v1/status/poll')) {
      remaining -= 1;
      return Promise.resolve(
        Response.json({ task_id: TASK, task_status: remaining > 0 ? 'started' : 'success' }),
      );
    }
    return Promise.resolve(Response.json({ document: { md_content: markdown } }));
  });
}

function sentRequest(spy: FetchSpy): { url: string; form: FormData } {
  const [url, init] = spy.mock.calls[0] ?? [];
  if (typeof url !== 'string') throw new Error('expected a string URL');
  const body = init instanceof Object && 'body' in init ? init.body : undefined;
  if (!(body instanceof FormData)) throw new Error('expected a multipart body');
  return { url, form: body };
}

const PDF = Buffer.from('%PDF-1.7');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DoclingParser', () => {
  it('is unconfigured without a URL, and says so instead of calling nowhere', async () => {
    expect(parser({ DOCLING_URL: '' }).isConfigured).toBe(false);
    await expect(parser({ DOCLING_URL: '' }).toMarkdown(PDF, { ocrLanguages: [] })).rejects.toThrow(
      /DOCLING_URL/,
    );
  });

  it('reads a document that has its own text, rather than recognising a picture of it', async () => {
    const spy = answers('## Ugovor\n\nText.');

    const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [] });

    expect(markdown).toBe('## Ugovor\n\nText.');
    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://docling:5001/v1/convert/file/async');
    expect(form.get('to_formats')).toBe('md');
    // Measured: the default backend splits diacritics into separate glyph runs — "li č ne".
    expect(form.get('pdf_backend')).toBe('pypdfium2');
    expect(form.get('do_ocr')).toBe('false');
    expect(form.get('force_ocr')).toBeNull();
  });

  it('forces a full OCR pass in the languages it was given, one field each', async () => {
    const spy = answers('Договор');

    await parser().toMarkdown(PDF, { ocrLanguages: ['rus', 'srp_latn'] });

    const { form } = sentRequest(spy);
    expect(form.get('force_ocr')).toBe('true');
    // 🔒 Named explicitly: the default engine has no Cyrillic model and, asked for Russian, falls
    // back to its Chinese model set and returns confident-looking nonsense.
    expect(form.get('ocr_preset')).toBe('tesseract');
    expect(form.getAll('ocr_lang')).toEqual(['rus', 'srp_latn']);
    expect(form.get('do_ocr')).toBeNull();
  });

  it('leaves picture description off unless it is switched on', async () => {
    const spy = answers('text');

    await parser().toMarkdown(PDF, { ocrLanguages: [] });

    expect(sentRequest(spy).form.get('do_picture_description')).toBeNull();
  });

  it('asks for captions when it is switched on', async () => {
    const spy = answers('text');

    await parser({ DOCLING_PICTURE_DESCRIPTION: 'true' }).toMarkdown(PDF, { ocrLanguages: [] });

    expect(sentRequest(spy).form.get('do_picture_description')).toBe('true');
  });

  it('drops the placeholders Docling writes in place of pictures it did not describe', async () => {
    answers('<!-- image -->\n\nInvoice');

    const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [] });

    // 🔒 Left in, they would count towards "does this have a text layer" and a scan of nothing but
    // pictures would never reach OCR (docs/05 §5.5).
    expect(markdown).not.toContain('image');
    expect(markdown).toContain('Invoice');
  });

  it('keeps a caption, which is text about the document rather than a note about the file', async () => {
    answers('<!-- image -->\n\nIn this image, we can see a QR code.');

    expect(
      await parser({ DOCLING_PICTURE_DESCRIPTION: 'true' }).toMarkdown(PDF, {
        ocrLanguages: [],
      }),
    ).toContain('QR code');
  });

  it('points at the missing model when captions are on and Docling answers 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('model not found', { status: 404 }),
    );

    await expect(
      parser({ DOCLING_PICTURE_DESCRIPTION: 'true' }).toMarkdown(PDF, { ocrLanguages: [] }),
    ).rejects.toThrow(/DOCLING_PICTURE_DESCRIPTION is on/);
  });

  it('reports any other failure with what the container said', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unsupported file type', { status: 415 }),
    );

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [] })).rejects.toThrow(
      /415.*unsupported file type/s,
    );
  });

  it('treats a document with no content as empty, not as a broken answer', async () => {
    answers(null);

    expect(await parser().toMarkdown(PDF, { ocrLanguages: [] })).toBe('');
  });

  it('fails loudly on an answer whose shape it does not know', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).includes('/v1/convert')
          ? Response.json({ task_id: TASK, task_status: 'pending' })
          : urlOf(input).includes('/v1/status/poll')
            ? Response.json({ task_id: TASK, task_status: 'success' })
            : Response.json({ markdown: 'text' }),
      ),
    );

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [] })).rejects.toThrow(
      /shape this version does not know/,
    );
  });

  it('waits through a task that is still working, instead of reading a result that is not there', async () => {
    const spy = answers('## Ugovor', { polls: 3 });

    expect(await parser().toMarkdown(PDF, { ocrLanguages: [] })).toBe('## Ugovor');

    const polls = spy.mock.calls.filter(
      (call) => call[0] !== undefined && urlOf(call[0]).includes('/v1/status/poll'),
    );
    expect(polls).toHaveLength(3);
    // 🔒 Long-polling, not busy-looping: the wait is on the server's side of the connection.
    const first = polls[0]?.[0];
    expect(first === undefined ? '' : urlOf(first)).toContain('wait=');
  });

  it('reports what Docling said when a task fails, rather than an empty document', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        urlOf(input).includes('/v1/convert')
          ? Response.json({ task_id: TASK, task_status: 'pending' })
          : Response.json({
              task_id: TASK,
              task_status: 'failure',
              error_message: 'page 3 is encrypted',
            }),
      ),
    );

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [] })).rejects.toThrow(
      /page 3 is encrypted/,
    );
  });

  it('tolerates a configured URL with a trailing slash', async () => {
    const spy = answers('text');

    await parser({ DOCLING_URL: 'http://docling:5001/' }).toMarkdown(PDF, { ocrLanguages: [] });

    expect(sentRequest(spy).url).toBe('http://docling:5001/v1/convert/file/async');
  });
});
