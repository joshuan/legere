import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  readBoundedJson,
  readBoundedText,
  toBuffer,
  type BinarySource,
} from '../../application/ports/binary-source';
import { DocumentParser, type ParseOptions } from '../../application/ports/document-parser';
import {
  ServiceUnavailableError,
  isUnavailableStatus,
  reachService,
} from '../../application/ports/service-unavailable';
import { ServiceGates } from '../../application/queue/service-gate';
import { AppConfig } from '../config/app-config';
import { callHeaders } from '../logging/async-call-context';

// Submit, wait, collect. The synchronous endpoint exists and is simpler, but it cannot be used for
// the work that takes long enough to care about: docling-serve answers 504 after 120 s, and Node's
// HTTP client gives up waiting for headers after 300 s — a conversion going perfectly well then
// fails as "fetch failed". Long-polling keeps every request short (docs/05 §5.5).
const CONVERT = '/v1/convert/file/async';
const POLL = '/v1/status/poll';
const RESULT = '/v1/result';
const POLL_WAIT_SEC = 5;

// How long one window's conversion may take: the layout parse works page by page, so the budget
// does too. The flat five minutes this used to be was a per-page allowance in disguise — 12.5 s a
// page over a full window — and a dense-table scan (a bank statement, a credit-bureau report)
// measures 23–25 s/page on the host this is meant for, so a 13-page statement sent as a single
// window burned the whole budget and failed while a 40-page sibling passed, split into windows
// that fit. The floor pays for Docling's own queue and warm-up, which a one-page window meets like
// any other. Captioning pictures stays flat: a vision model runs once per picture on the CPU, and
// pages say nothing about pictures.
const BUDGET_PER_PAGE_MS = 30 * 1000;
const BUDGET_FLOOR_MS = 2 * 60 * 1000;
const BUDGET_WITH_CAPTIONS_MS = 55 * 60 * 1000;

// 🔒 The whole parse, across every window, shares one deadline under the document-process job's own
// hour (docs/05 §5.4a, docs/06 §6.8): windows must not let a long document spend thirteen budgets
// where one document used to spend one.
const PARSE_DEADLINE_MS = 55 * 60 * 1000;

// How many pages Docling is asked for at a time (docs/05 §5.5 step 3). A layout parse holds its
// whole answer in memory while it builds it, so the peak grows with the document — 3–4 GB for a
// long manual on a host that has four, which is how one document took down every service beside it.
// Half the two dozen it began as: a dozen halves that ceiling again and halves the wait the slowest
// window can cost, doubling the headroom the per-page budget above buys. A constant like every
// §5.4a bound: the right number is a property of the parser, not something an operator can know.
export const DOCLING_PAGE_WINDOW = 12;

// 🔒 The budgets above bound the *conversion*; these bound each HTTP request that carries it, which
// is a different thing and the one a wedged container defeats. Long-polling only keeps requests short
// as long as the other end plays along: with no signal, undici's 300 s header timeout is the backstop
// and a drip of one byte a minute defeats even that, holding a processing worker for ever
// (docs/05 §5.4).
//
// Submitting means uploading the canonical PDF, so it gets room for a large one; a poll is asked to
// wait `POLL_WAIT_SEC` and anything much past that is a container in trouble; collecting the result
// is one JSON document off disk.
const SUBMIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_TIMEOUT_MS = (POLL_WAIT_SEC + 25) * 1000;
const RESULT_TIMEOUT_MS = 2 * 60 * 1000;

// 🔒 And how much may come back. The result carries the whole document as Markdown — generous, but
// bounded, because this process is also the HTTP surface (docs/02 ADR-002). A task acknowledgement,
// a poll answer and an error detail are all a few fields.
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_SMALL_ANSWER_BYTES = 64 * 1024;

// How big a picture has to be, as a share of the page, before it is worth describing. Docling's own
// default is 5%, which quietly skips exactly the pictures a document archive cares about — a logo,
// a stamp, a QR code are all smaller than that, and the flag then looks broken rather than strict.
const PICTURE_MIN_AREA = 0.01;

// Only the field we read; the answer also carries timings and confidence scores.
const conversionSchema = z.object({
  document: z.object({ md_content: z.string().nullable() }),
});

// Both the acceptance and every poll answer come back in this shape.
const taskSchema = z.object({
  task_id: z.string(),
  task_status: z.string(),
  error_message: z.string().nullish(),
});

@Injectable()
export class DoclingParser extends DocumentParser {
  private readonly baseUrl: string;
  private readonly describePictures: boolean;

  constructor(
    config: AppConfig,
    private readonly gates: ServiceGates,
  ) {
    super();
    this.baseUrl = config.get('DOCLING_URL').replace(/\/+$/, '');
    this.describePictures = config.get('DOCLING_PICTURE_DESCRIPTION');
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  async toMarkdown(source: BinarySource, options: ParseOptions): Promise<string> {
    if (!this.isConfigured) throw new Error('DOCLING_URL is not configured');

    const bytes = await toBuffer(source);
    // 🔒 Docling is asked for the document a window at a time (docs/05 §5.5 step 3): the same
    // upload each time with only the range moving, so the longest document costs Docling no more
    // memory than a two-dozen-page one. A document at or under the window — or one whose page count
    // is unknown — is one window with no `page_range` at all, byte for byte the request this step
    // has always sent.
    const windows = pageWindows(options.pageCount);
    const parseDeadline = Date.now() + PARSE_DEADLINE_MS;

    const parts: string[] = [];
    for (const window of windows) {
      // 🔒 One *window* is a single unit of the `docling` gate — submitting, every poll, and
      // collecting the result (docs/05 §5.4b). The expensive work happens on the Docling server
      // between those requests, so metering the polls would count the cheapest exchanges of the
      // conversation while the conversion everybody is waiting on ran through ungated. And the
      // gate's cooldown breathes between the windows of one document, which is what a cooldown is
      // for.
      parts.push(
        await this.gates.run('docling', () => this.convert(bytes, options, window, parseDeadline)),
      );
    }
    return parts.filter((part) => part !== '').join('\n\n');
  }

  // One window of the parse, stitched back by the caller in page order.
  private async convert(
    bytes: Buffer,
    options: ParseOptions,
    window: PageWindow,
    parseDeadline: number,
  ): Promise<string> {
    const budgetMs = this.windowBudgetMs(windowPageCount(window, options.pageCount), parseDeadline);
    const taskId = await this.submit(this.buildForm(bytes, options, window));
    await this.awaitTask(taskId, budgetMs);

    const result = conversionSchema.safeParse(
      await this.get(`${RESULT}/${taskId}`, RESULT_TIMEOUT_MS, MAX_RESULT_BYTES),
    );
    if (!result.success) throw new Error('Docling answered in a shape this version does not know');

    return stripImagePlaceholders(result.data.document.md_content ?? '');
  }

  // What this window may spend: its pages at the per-page rate, floored, capped by what is left of
  // the whole parse's deadline. A parse that has overstayed is cut before the next upload, not
  // after it.
  private windowBudgetMs(pages: number, parseDeadline: number): number {
    const remaining = parseDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Docling did not finish within ${Math.round(PARSE_DEADLINE_MS / 60_000)} minutes`,
      );
    }
    const budget = this.describePictures
      ? BUDGET_WITH_CAPTIONS_MS
      : Math.max(BUDGET_FLOOR_MS, pages * BUDGET_PER_PAGE_MS);
    return Math.min(budget, remaining);
  }

  private buildForm(bytes: Buffer, options: ParseOptions, window: PageWindow): FormData {
    const form = new FormData();
    form.append('files', new Blob([viewOf(bytes)]), 'input.pdf');
    form.append('to_formats', 'md');
    // pypdfium2 over the default parser: measured on real documents, the default splits diacritics
    // into separate glyph runs — "li č ne" instead of "lične" — which breaks the word for search as
    // well as for reading (docs/05 §5.5).
    form.append('pdf_backend', 'pypdfium2');
    if (window !== null) {
      // Two repeated fields, 1-based and inclusive — verified against docling-serve itself, which
      // answers 200 with the whole document when the field name is wrong.
      form.append('page_range', String(window[0]));
      form.append('page_range', String(window[1]));
    }

    if (options.ocrLanguages.length === 0) {
      // The document carries its own text: reading it is both faster and more accurate than
      // recognising a picture of it.
      form.append('do_ocr', 'false');
    } else {
      form.append('force_ocr', 'true');
      // Named explicitly: the default engine has no Cyrillic model and, asked for Russian, silently
      // falls back to its Chinese model set — returning confident-looking nonsense.
      form.append('ocr_preset', 'tesseract');
      for (const language of options.ocrLanguages) form.append('ocr_lang', language);
    }

    // A caption under every picture, from the vision model in the Docling image. Slow enough that it
    // is opt-in (docs/12 §12.4), so the flag is passed only when it is on.
    if (this.describePictures) {
      form.append('do_picture_description', 'true');
      form.append('picture_description_area_threshold', String(PICTURE_MIN_AREA));
    }
    return form;
  }

  // The whole exchange — request, status check, body read — with transport failures and 502/503/504
  // classified as the service being away rather than the document being broken (docs/05 §5.4e).
  private async submit(form: FormData): Promise<string> {
    return reachService('docling', async () => {
      // The id of the step this conversion belongs to, so docling-serve logs the same one.
      const response = await fetch(`${this.baseUrl}${CONVERT}`, {
        method: 'POST',
        body: form,
        headers: callHeaders(),
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
      if (isUnavailableStatus(response.status)) {
        throw new ServiceUnavailableError('docling', `${CONVERT} answered ${response.status}`);
      }
      if (!response.ok) {
        const detail = await readBoundedText(response, MAX_SMALL_ANSWER_BYTES).catch(() => '');
        // The one failure worth spelling out: captions need a model that is not in the stock image,
        // and "404" on its own sends nobody anywhere useful.
        const hint =
          this.describePictures && response.status === 404
            ? ' — DOCLING_PICTURE_DESCRIPTION is on and the Docling image has no picture-description' +
              ' model. Build one with `npm run docling:captions`, then restart the container.'
            : '';
        throw new Error(
          `Docling ${CONVERT} failed with ${response.status}: ${detail.slice(0, 500)}${hint}`,
        );
      }

      const accepted = taskSchema.safeParse(
        await readBoundedJson(response, MAX_SMALL_ANSWER_BYTES),
      );
      if (!accepted.success) throw new Error('Docling accepted the document without a task id');
      return accepted.data.task_id;
    });
  }

  // Long-polls until the task settles. Each request is short by construction, which is the point:
  // a conversion that takes 17 minutes is not a 17-minute HTTP request anybody can keep alive.
  private async awaitTask(taskId: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const state = taskSchema.safeParse(
        await this.get(
          `${POLL}/${taskId}?wait=${POLL_WAIT_SEC}`,
          POLL_TIMEOUT_MS,
          MAX_SMALL_ANSWER_BYTES,
        ),
      );
      if (!state.success) throw new Error('Docling reported a task state this version cannot read');

      if (state.data.task_status === 'success') return;
      if (state.data.task_status === 'failure') {
        throw new Error(
          `Docling failed to convert the document: ${state.data.error_message ?? ''}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Docling did not finish within ${Math.round(budgetMs / 60_000)} minutes (task ${taskId})`,
        );
      }
    }
  }

  private async get(path: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
    return reachService('docling', async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: callHeaders(),
        // 🔒 Headers and body alike: when it fires, undici tears the body stream down too.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isUnavailableStatus(response.status)) {
        throw new ServiceUnavailableError('docling', `${path} answered ${response.status}`);
      }
      if (!response.ok) {
        const detail = await readBoundedText(response, MAX_SMALL_ANSWER_BYTES).catch(() => '');
        throw new Error(`Docling ${path} failed with ${response.status}: ${detail.slice(0, 500)}`);
      }
      return readBoundedJson(response, maxBytes);
    });
  }
}

// A window of pages, 1-based and inclusive; null is the whole document in one request, with no
// `page_range` field at all.
type PageWindow = readonly [number, number] | null;

// How many pages a window carries, for its budget: a ranged window knows, a whole-document request
// is the page count where something counted it and a full window's worth where nothing did.
function windowPageCount(window: PageWindow, pageCount: number): number {
  if (window !== null) return window[1] - window[0] + 1;
  return pageCount > 0 ? pageCount : DOCLING_PAGE_WINDOW;
}

// The ranges a document is fetched in (docs/05 §5.5 step 3), clamped to the page count because a
// range past the last page is a request Docling rejects outright. A page count of zero is a
// document nothing counted — one window, whole, exactly as before windows existed.
function pageWindows(pageCount: number): PageWindow[] {
  if (pageCount <= DOCLING_PAGE_WINDOW) return [null];
  const windows: PageWindow[] = [];
  for (let from = 1; from <= pageCount; from += DOCLING_PAGE_WINDOW) {
    windows.push([from, Math.min(from + DOCLING_PAGE_WINDOW - 1, pageCount)]);
  }
  return windows;
}

// Docling marks every picture it did not describe with an HTML comment. It is a note about the file,
// not text from it, and it would otherwise count towards the "does this have a text layer" measure.
// A described picture keeps the comment and gains a paragraph under it, which is text and stays.
function stripImagePlaceholders(markdown: string): string {
  return markdown.replace(/<!--\s*image\s*-->/g, '');
}

// A Buffer is a view over an ArrayBufferLike, which may in principle be shared memory, while Blob
// accepts only a view over a plain ArrayBuffer. Re-viewing the very same bytes — `slice` here used to
// copy them — keeps a large document from being held twice while it uploads (docs/05 §5.4).
function viewOf(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const underlying = bytes.buffer;
  if (!(underlying instanceof ArrayBuffer)) {
    throw new Error('unexpected shared memory backing a document buffer');
  }
  return new Uint8Array(underlying, bytes.byteOffset, bytes.byteLength);
}
