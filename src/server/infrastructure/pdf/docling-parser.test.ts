import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ServiceUnavailableError } from '../../application/ports/service-unavailable';
import { ServiceGates } from '../../application/queue/service-gate';
import { FixedClock } from '../../../../test/helpers/fakes';
import { loadConfig } from '../config/app-config';
import { DoclingParser } from './docling-parser';

// The multipart body *is* the contract: Docling answers 200 with worse output when a field name is
// wrong, so a mistake here shows up as mangled text weeks later, not as an error. Same reasoning as
// the Stirling toolbox test next to this one.
function parser(
  overrides: Record<string, string> = {},
  gates: ServiceGates = new ServiceGates(new FixedClock()),
): DoclingParser {
  return new DoclingParser(
    loadConfig({
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_SECRET: 'test-secret-minimum-32-characters!!',
      S3_ACCESS_KEY_ID: 'test-access-key',
      S3_SECRET_ACCESS_KEY: 'test-secret-key',
      DOCLING_URL: 'http://docling:5001',
      ...overrides,
    }),
    gates,
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

// Which of the three requests a URL is, for a test that cares about their order.
function endpointOf(url: string): string {
  if (url.includes('/v1/convert')) return 'convert';
  return url.includes('/v1/status/poll') ? 'poll' : 'result';
}

const PDF = Buffer.from('%PDF-1.7');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DoclingParser', () => {
  it('is unconfigured without a URL, and says so instead of calling nowhere', async () => {
    expect(parser({ DOCLING_URL: '' }).isConfigured).toBe(false);
    await expect(
      parser({ DOCLING_URL: '' }).toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 }),
    ).rejects.toThrow(/DOCLING_URL/);
  });

  it('reads a document that has its own text, rather than recognising a picture of it', async () => {
    const spy = answers('## Ugovor\n\nText.');

    const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 });

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

    await parser().toMarkdown(PDF, { ocrLanguages: ['rus', 'srp_latn'], pageCount: 1 });

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

    await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 });

    expect(sentRequest(spy).form.get('do_picture_description')).toBeNull();
  });

  it('asks for captions when it is switched on', async () => {
    const spy = answers('text');

    await parser({ DOCLING_PICTURE_DESCRIPTION: 'true' }).toMarkdown(PDF, {
      ocrLanguages: [],
      pageCount: 1,
    });

    expect(sentRequest(spy).form.get('do_picture_description')).toBe('true');
  });

  it('drops the placeholders Docling writes in place of pictures it did not describe', async () => {
    answers('<!-- image -->\n\nInvoice');

    const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 });

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
        pageCount: 1,
      }),
    ).toContain('QR code');
  });

  it('points at the missing model when captions are on and Docling answers 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('model not found', { status: 404 }),
    );

    await expect(
      parser({ DOCLING_PICTURE_DESCRIPTION: 'true' }).toMarkdown(PDF, {
        ocrLanguages: [],
        pageCount: 1,
      }),
    ).rejects.toThrow(/DOCLING_PICTURE_DESCRIPTION is on/);
  });

  it('reports any other failure with what the container said', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unsupported file type', { status: 415 }),
    );

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })).rejects.toThrow(
      /415.*unsupported file type/s,
    );
  });

  it('treats a document with no content as empty, not as a broken answer', async () => {
    answers(null);

    expect(await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })).toBe('');
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

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })).rejects.toThrow(
      /shape this version does not know/,
    );
  });

  it('waits through a task that is still working, instead of reading a result that is not there', async () => {
    const spy = answers('## Ugovor', { polls: 3 });

    expect(await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })).toBe('## Ugovor');

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

    await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })).rejects.toThrow(
      /page 3 is encrypted/,
    );
  });

  // 🔒 One whole parse is one unit of the `docling` gate: submitting, every poll and collecting the
  // result (docs/05 §5.4b). The expensive work happens on the Docling server between those
  // requests, so metering the polls would count the cheapest exchanges and let the conversion
  // everybody is waiting on run through ungated.
  it('spends a single gate slot on a whole parse, every poll included', async () => {
    const gates = new ServiceGates(new FixedClock());
    gates.configure({ docling: { concurrency: 1, cooldownSeconds: 0 } });
    const spy = answers('# Done', { polls: 2 });
    const docling = parser({}, gates);

    // Both asked for at once; the gate holds one of them at the door.
    const first = docling.toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 });
    const second = docling.toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 });
    await Promise.all([first, second]);

    const requests = spy.mock.calls.map(([input]) => urlOf(input));
    // Submit, poll, poll, collect — and only then does the second parse reach the container.
    expect(requests.slice(0, 4).map(endpointOf)).toEqual(['convert', 'poll', 'poll', 'result']);
    expect(requests[4]).toContain('/v1/convert');
  });

  it('tolerates a configured URL with a trailing slash', async () => {
    const spy = answers('text');

    await parser({ DOCLING_URL: 'http://docling:5001/' }).toMarkdown(PDF, {
      ocrLanguages: [],
      pageCount: 1,
    });

    expect(sentRequest(spy).url).toBe('http://docling:5001/v1/convert/file/async');
  });

  // A parse no bigger than the window (docs/05 §5.5 step 3): the longest document costs Docling no
  // more memory than a dozen-page one, because it is asked for a window at a time.
  describe('a parse no bigger than the window (docs/05 §5.5 step 3)', () => {
    function formOf(init: RequestInit | undefined): FormData {
      const body = init instanceof Object && 'body' in init ? init.body : undefined;
      if (!(body instanceof FormData)) throw new Error('expected a multipart body');
      return body;
    }

    // Submit, poll, collect per window; the task id carries the window's first page, so the result
    // can answer with a part the test recognises.
    function answersPerWindow(): FetchSpy {
      return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = urlOf(input);
        if (url.includes('/v1/convert')) {
          const from = formOf(init).getAll('page_range')[0];
          const label = typeof from === 'string' ? from : 'whole';
          return Promise.resolve(
            Response.json({ task_id: `task-${label}`, task_status: 'pending' }),
          );
        }
        if (url.includes('/v1/status/poll')) {
          return Promise.resolve(Response.json({ task_id: TASK, task_status: 'success' }));
        }
        const task = url.split('/').pop() ?? '';
        return Promise.resolve(Response.json({ document: { md_content: `part ${task}` } }));
      });
    }

    it('fans a long document into page windows and stitches the Markdown in order', async () => {
      const spy = answersPerWindow();

      const markdown = await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 60 });

      // Stitched in page order, one part per window.
      expect(markdown).toBe(
        'part task-1\n\npart task-13\n\npart task-25\n\npart task-37\n\npart task-49',
      );
      const submits = spy.mock.calls.filter(([input]) => urlOf(input).includes('/v1/convert'));
      // 1-based, inclusive, and clamped at the last page rather than asked past it — a range past
      // the end is a request Docling rejects outright.
      expect(submits.map(([, init]) => formOf(init).getAll('page_range'))).toEqual([
        ['1', '12'],
        ['13', '24'],
        ['25', '36'],
        ['37', '48'],
        ['49', '60'],
      ]);
    });

    it('sends no page_range at all for a document at or under the window', async () => {
      const spy = answers('short document');

      await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 12 });

      // Byte for byte the request this step has always sent.
      expect(sentRequest(spy).form.getAll('page_range')).toEqual([]);
      expect(spy.mock.calls.filter(([input]) => urlOf(input).includes('/v1/convert'))).toHaveLength(
        1,
      );
    });

    it('nor for a document whose page count nothing counted', async () => {
      const spy = answers('unknown length');

      await parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 0 });

      expect(sentRequest(spy).form.getAll('page_range')).toEqual([]);
    });

    it('runs each window through the gate as its own unit', async () => {
      const gates = new ServiceGates(new FixedClock());
      const spy = vi.spyOn(gates, 'run');
      answersPerWindow();

      await parser({}, gates).toMarkdown(PDF, { ocrLanguages: [], pageCount: 60 });

      // Five windows, five units: the cooldown an operator set breathes between the windows of
      // one document, not only between documents (docs/05 §5.4b).
      expect(spy).toHaveBeenCalledTimes(5);
      expect(spy.mock.calls.every(([service]) => service === 'docling')).toBe(true);
    });

    it('surfaces a window failing mid-parse as the parse failing', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = urlOf(input);
        if (url.includes('/v1/convert')) {
          const from = formOf(init).getAll('page_range')[0];
          if (from === '25') {
            return Promise.resolve(new Response('page 30 is encrypted', { status: 422 }));
          }
          return Promise.resolve(Response.json({ task_id: TASK, task_status: 'pending' }));
        }
        if (url.includes('/v1/status/poll')) {
          return Promise.resolve(Response.json({ task_id: TASK, task_status: 'success' }));
        }
        return Promise.resolve(Response.json({ document: { md_content: 'part' } }));
      });

      await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 30 })).rejects.toThrow(
        /422.*page 30 is encrypted/s,
      );
    });

    it('cuts a parse that overstays the shared deadline before the next upload', async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
          const url = urlOf(input);
          if (url.includes('/v1/convert')) {
            return Promise.resolve(Response.json({ task_id: TASK, task_status: 'pending' }));
          }
          if (url.includes('/v1/status/poll')) {
            // The first window alone eats the whole 55-minute deadline.
            vi.setSystemTime(Date.now() + 56 * 60_000);
            return Promise.resolve(Response.json({ task_id: TASK, task_status: 'success' }));
          }
          return Promise.resolve(Response.json({ document: { md_content: 'part' } }));
        });

        await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 30 })).rejects.toThrow(
          /did not finish within 55 minutes/,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // One window's conversion budget scales with the pages it carries (docs/05 §5.4a): the layout
  // parse works page by page, and the flat budget this replaced starved a dense short document
  // while longer ones passed, windowed.
  describe('the budget of one window (docs/05 §5.4a)', () => {
    // A task still working when the budget has already passed: the poll moves the clock, then
    // answers "started", and the deadline check cuts the conversion.
    function pollOutlivesBudget(minutes: number): void {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = urlOf(input);
        if (url.includes('/v1/convert')) {
          return Promise.resolve(Response.json({ task_id: TASK, task_status: 'pending' }));
        }
        if (url.includes('/v1/status/poll')) {
          vi.setSystemTime(Date.now() + minutes * 60_000);
          return Promise.resolve(Response.json({ task_id: TASK, task_status: 'started' }));
        }
        return Promise.resolve(Response.json({ document: { md_content: 'part' } }));
      });
    }

    it('gives a dozen dense pages twelve minutes, not five flat', async () => {
      vi.useFakeTimers();
      try {
        pollOutlivesBudget(13);
        await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 12 })).rejects.toThrow(
          /did not finish within 12 minutes/,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('floors at two minutes — a one-page window still pays the queue and the warm-up', async () => {
      vi.useFakeTimers();
      try {
        pollOutlivesBudget(3);
        await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })).rejects.toThrow(
          /did not finish within 2 minutes/,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('budgets a document nothing counted as a full window', async () => {
      vi.useFakeTimers();
      try {
        pollOutlivesBudget(13);
        await expect(parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 0 })).rejects.toThrow(
          /did not finish within 12 minutes/,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The service being away is a different failure from the document being broken, and the client is
  // the only layer that can tell them apart (docs/05 §5.4e).
  describe('the service being away (docs/05 §5.4e)', () => {
    it('classifies the transport failing as the service being unreachable', async () => {
      // undici rejects every network-level failure this way.
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    it('classifies a 502 the same way — a proxy answering for a container that is not there', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

      await expect(
        parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    it('classifies its own timeout firing mid-exchange', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );

      await expect(
        parser().toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableError);
    });

    it('leaves a 500 as the document owning the failure — the service answered', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('conversion blew up', { status: 500 }),
      );

      const failure: unknown = await parser()
        .toMarkdown(PDF, { ocrLanguages: [], pageCount: 1 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ServiceUnavailableError);
    });
  });
});
