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

function answers(markdown: string | null): Response {
  return Response.json({ document: { md_content: markdown } });
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
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('## Ugovor\n\nText.'));

    const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [] });

    expect(markdown).toBe('## Ugovor\n\nText.');
    const { url, form } = sentRequest(spy);
    expect(url).toBe('http://docling:5001/v1/convert/file');
    expect(form.get('to_formats')).toBe('md');
    // Measured: the default backend splits diacritics into separate glyph runs — "li č ne".
    expect(form.get('pdf_backend')).toBe('pypdfium2');
    expect(form.get('do_ocr')).toBe('false');
    expect(form.get('force_ocr')).toBeNull();
  });

  it('forces a full OCR pass in the languages it was given, one field each', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('Договор'));

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
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('text'));

    await parser().toMarkdown(PDF, { ocrLanguages: [] });

    expect(sentRequest(spy).form.get('do_picture_description')).toBeNull();
  });

  it('asks for captions when it is switched on', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('text'));

    await parser({ DOCLING_PICTURE_DESCRIPTION: 'true' }).toMarkdown(PDF, { ocrLanguages: [] });

    expect(sentRequest(spy).form.get('do_picture_description')).toBe('true');
  });

  it('drops the placeholders Docling writes in place of pictures it did not describe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('<!-- image -->\n\nInvoice'));

    const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [] });

    // 🔒 Left in, they would count towards "does this have a text layer" and a scan of nothing but
    // pictures would never reach OCR (docs/05 §5.5).
    expect(markdown).not.toContain('image');
    expect(markdown).toContain('Invoice');
  });

  it('keeps a caption, which is text about the document rather than a note about the file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      answers('<!-- image -->\n\nIn this image, we can see a QR code.'),
    );

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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers(null));

    expect(await parser().toMarkdown(PDF, { ocrLanguages: [] })).toBe('');
  });

  it('fails loudly on an answer whose shape it does not know', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ markdown: 'text' }));

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [] })).rejects.toThrow(
      /shape this version does not know/,
    );
  });

  it('tolerates a configured URL with a trailing slash', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answers('text'));

    await parser({ DOCLING_URL: 'http://docling:5001/' }).toMarkdown(PDF, { ocrLanguages: [] });

    expect(sentRequest(spy).url).toBe('http://docling:5001/v1/convert/file');
  });
});
