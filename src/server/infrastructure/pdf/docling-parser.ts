import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import { DocumentParser, type ParseOptions } from '../../application/ports/document-parser';
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

// How long the whole conversion may take. Parsing a document is seconds; captioning its pictures is
// minutes, because a vision model runs once per picture on the CPU. The long budget stays under the
// document-process job's own hour (docs/06 §6.8).
const BUDGET_MS = 5 * 60 * 1000;
const BUDGET_WITH_CAPTIONS_MS = 55 * 60 * 1000;

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

  constructor(config: AppConfig) {
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
    const form = new FormData();
    form.append('files', new Blob([viewOf(bytes)]), 'input.pdf');
    form.append('to_formats', 'md');
    // pypdfium2 over the default parser: measured on real documents, the default splits diacritics
    // into separate glyph runs — "li č ne" instead of "lične" — which breaks the word for search as
    // well as for reading (docs/05 §5.5).
    form.append('pdf_backend', 'pypdfium2');

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

    const taskId = await this.submit(form);
    await this.awaitTask(taskId, this.describePictures ? BUDGET_WITH_CAPTIONS_MS : BUDGET_MS);

    const result = conversionSchema.safeParse(await this.get(`${RESULT}/${taskId}`));
    if (!result.success) throw new Error('Docling answered in a shape this version does not know');

    return stripImagePlaceholders(result.data.document.md_content ?? '');
  }

  private async submit(form: FormData): Promise<string> {
    // The id of the step this conversion belongs to, so docling-serve logs the same one.
    const response = await fetch(`${this.baseUrl}${CONVERT}`, {
      method: 'POST',
      body: form,
      headers: callHeaders(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
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

    const accepted = taskSchema.safeParse(await response.json());
    if (!accepted.success) throw new Error('Docling accepted the document without a task id');
    return accepted.data.task_id;
  }

  // Long-polls until the task settles. Each request is short by construction, which is the point:
  // a conversion that takes 17 minutes is not a 17-minute HTTP request anybody can keep alive.
  private async awaitTask(taskId: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const state = taskSchema.safeParse(await this.get(`${POLL}/${taskId}?wait=${POLL_WAIT_SEC}`));
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

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: callHeaders() });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Docling ${path} failed with ${response.status}: ${detail.slice(0, 500)}`);
    }
    return response.json();
  }
}

// Docling marks every picture it did not describe with an HTML comment. It is a note about the file,
// not text from it, and it would otherwise count towards the "does this have a text layer" measure.
// A described picture keeps the comment and gains a paragraph under it, which is text and stays.
function stripImagePlaceholders(markdown: string): string {
  return markdown.replace(/<!--\s*image\s*-->/g, '');
}

// Blob wants an ArrayBuffer; this views the same memory rather than copying the document.
function viewOf(bytes: Buffer): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (!(buffer instanceof ArrayBuffer)) return new Uint8Array(bytes).buffer;
  return buffer.slice(byteOffset, byteOffset + byteLength);
}
