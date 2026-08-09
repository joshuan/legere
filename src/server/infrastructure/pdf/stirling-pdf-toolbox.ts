import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  MAX_BINARY_BYTES,
  readBoundedBody,
  readBoundedJson,
  readBoundedText,
  toBuffer,
  type BinarySource,
} from '../../application/ports/binary-source';
import {
  PdfToolbox,
  type FirstPageOptions,
  type NamedBinary,
  type PdfMetadata,
} from '../../application/ports/pdf-toolbox';
import { AppConfig } from '../config/app-config';
import { callHeaders } from '../logging/async-call-context';

// Stirling's REST surface (ADR-012). One endpoint per port method; the container is reached over the
// internal network and is never exposed.
const ENDPOINTS = {
  toPdf: '/api/v1/convert/file/pdf',
  pdfToImage: '/api/v1/convert/pdf/img',
  ocr: '/api/v1/misc/ocr-pdf',
  imagesToPdf: '/api/v1/convert/img/pdf',
  mergePdfs: '/api/v1/general/merge-pdfs',
  updateMetadata: '/api/v1/misc/update-metadata',
  pageCount: '/api/v1/analysis/page-count',
  pdfToMarkdown: '/api/v1/convert/pdf/markdown',
} as const;

// 🔒 How long each of them may take. Without one, undici's 300 s header timeout is the only backstop
// and a slow drip defeats it entirely: a wedged container would hold a processing worker for ever,
// and there are only `document-process` concurrency of them (docs/05 §5.4). The budgets are what the
// work costs on the slowest hardware this is meant to run on, and every one of them stays well under
// the hour a `document-process` job has (docs/06 §6.8).
//
// Written as constants rather than as env knobs: an operator has no way to know what "the right
// Stirling timeout" is, and an instance that needs a different one has a container problem to fix.
const TIMEOUTS_MS: Record<keyof typeof ENDPOINTS, number> = {
  // LibreOffice starting up and rendering an office document — the slow one of the conversions.
  toPdf: 5 * 60_000,
  // One page rasterized at 150 dpi.
  pdfToImage: 2 * 60_000,
  // Tesseract over every page of a scan, one language model per language asked for. The long pole of
  // the whole pipeline, and the reason the budget is not simply one number for the container.
  ocr: 30 * 60_000,
  imagesToPdf: 5 * 60_000,
  mergePdfs: 5 * 60_000,
  // Rewriting a metadata dictionary; anything slower is a container in trouble.
  updateMetadata: 60_000,
  pageCount: 60_000,
  pdfToMarkdown: 5 * 60_000,
};

// 🔒 And how much each may bring back. A PDF or a Markdown conversion is bounded like any other
// document this instance holds in memory (`MAX_BINARY_BYTES`, docs/05 §5.4). The small answers — a
// page count, an error detail that is truncated to 500 characters anyway — are bounded by what they
// are for, so a container answering a one-field question with a gigabyte is refused at the first
// chunk past the bound.
const MAX_SMALL_ANSWER_BYTES = 64 * 1024;

const DEFAULT_PREVIEW_DPI = 150;

// Only the field we act on; the analysis endpoint returns more.
const pageCountSchema = z.object({ pageCount: z.number().int().nonnegative() });

@Injectable()
export class StirlingPdfToolbox extends PdfToolbox {
  private readonly baseUrl: string;

  constructor(config: AppConfig) {
    super();
    this.baseUrl = config.get('STIRLING_URL').replace(/\/+$/, '');
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  async toPdf(source: NamedBinary): Promise<Buffer> {
    const form = new FormData();
    // LibreOffice picks its input filter from the extension, so the original name has to travel
    // with the bytes — an .xlsx uploaded as "file" would be read as something else entirely.
    form.append('fileInput', await blobOf(source.body), source.fileName);
    return this.postForBytes('toPdf', form);
  }

  async pdfFirstPageJpg(source: BinarySource, options: FirstPageOptions = {}): Promise<Buffer> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');
    form.append('pageNumbers', '1');
    form.append('imageFormat', 'jpeg');
    // "single" returns the image itself; "multiple" would wrap even a one-page result in a zip.
    form.append('singleOrMultiple', 'single');
    form.append('colorType', 'color');
    form.append('dpi', String(options.dpi ?? DEFAULT_PREVIEW_DPI));
    return this.postForBytes('pdfToImage', form);
  }

  async pdfToMarkdown(source: BinarySource): Promise<string> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');
    const bytes = await this.postForBytes('pdfToMarkdown', form);
    return unwrapLayoutTables(stripImagePlaceholders(bytes.toString('utf8')));
  }

  async ocrPdf(source: BinarySource, languages: readonly string[]): Promise<Buffer> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');
    for (const language of languages) form.append('languages', language);
    // force-ocr, not skip-text: OCR runs only for documents already judged to have no meaningful
    // text layer (docs/05 §5.5 step 3), and skip-text would leave a page holding three stray
    // characters exactly as unreadable as it was.
    form.append('ocrType', 'force-ocr');
    // The recognized text goes underneath the page image, so the scan still looks like the original.
    form.append('ocrRenderType', 'sandwich');
    form.append('sidecar', 'false');

    try {
      return await this.postForBytes('ocr', form);
    } catch (error) {
      throw missingLanguageData(error, languages) ?? error;
    }
  }

  async imagesToPdf(images: readonly NamedBinary[]): Promise<Buffer> {
    if (images.length === 0) throw new Error('imagesToPdf needs at least one image');

    const form = new FormData();
    // Page order is the order of the parts (docs/05 §5.6: page order = item order).
    for (const image of images) {
      form.append('fileInput', await blobOf(image.body), image.fileName);
    }
    form.append('fitOption', 'maintainAspectRatio');
    form.append('colorType', 'color');
    form.append('autoRotate', 'false');
    return this.postForBytes('imagesToPdf', form);
  }

  async mergePdfs(parts: readonly BinarySource[]): Promise<Buffer> {
    if (parts.length === 0) throw new Error('mergePdfs needs at least one part');

    const form = new FormData();
    // The order of the fields is the order of the pages, and `orderProvided` is what tells Stirling
    // to keep it instead of sorting by name or by date (docs/05 §5.5 step 1).
    for (const [index, part] of parts.entries()) {
      form.append('fileInput', await blobOf(part), `part-${String(index).padStart(4, '0')}.pdf`);
    }
    form.append('sortType', 'orderProvided');
    form.append('removeCertSign', 'false');
    return this.postForBytes('mergePdfs', form);
  }

  async stampMetadata(source: BinarySource, metadata: PdfMetadata): Promise<Buffer> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');
    // deleteAll would wipe what the source PDFs carried; this pass adds what Legere knows and
    // leaves the rest of the fields as they arrived.
    form.append('deleteAll', 'false');
    form.append('title', metadata.title);
    form.append('producer', 'Legere');
    if (metadata.date !== null) {
      form.append('creationDate', stirlingDate(metadata.date));
      form.append('modificationDate', stirlingDate(metadata.date));
    }
    return this.postForBytes('updateMetadata', form);
  }

  async pdfPageCount(source: BinarySource): Promise<number> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');

    const response = await this.post('pageCount', form);
    const parsed = pageCountSchema.safeParse(
      await readBoundedJson(response, MAX_SMALL_ANSWER_BYTES),
    );
    if (!parsed.success) throw new Error('Stirling returned an unreadable page count');
    return parsed.data.pageCount;
  }

  private async postForBytes(endpoint: keyof typeof ENDPOINTS, form: FormData): Promise<Buffer> {
    const response = await this.post(endpoint, form);
    return readBoundedBody(response, MAX_BINARY_BYTES);
  }

  private async post(endpoint: keyof typeof ENDPOINTS, form: FormData): Promise<Response> {
    const path = ENDPOINTS[endpoint];
    // The id of the step this call belongs to travels with it, so the same line can be found in
    // Stirling's log and in the document's (docs/03 §3.3.18).
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: form,
      headers: callHeaders(),
      // 🔒 The whole exchange, headers and body alike: when it fires, undici tears the body stream
      // down too, so a container that answers and then drips cannot hold the worker either.
      signal: AbortSignal.timeout(TIMEOUTS_MS[endpoint]),
    });
    if (!response.ok) {
      // The body carries Stirling's own message; it goes into the job error so the failure is
      // diagnosable from the admin panel instead of being just a status code.
      const detail = await readBoundedText(response, MAX_SMALL_ANSWER_BYTES).catch(() => '');
      throw new Error(
        `Stirling ${path} failed with ${response.status}${detail === '' ? '' : `: ${truncate(detail)}`}`,
      );
    }
    return response;
  }
}

async function blobOf(source: BinarySource): Promise<Blob> {
  const bytes = await toBuffer(source);
  // A Buffer is a view over an ArrayBufferLike, which may in principle be shared memory, while Blob
  // accepts only a view over a plain ArrayBuffer. Re-viewing the very same bytes — rather than
  // copying them — keeps a large scan from being held twice while it uploads.
  const underlying = bytes.buffer;
  if (!(underlying instanceof ArrayBuffer)) {
    throw new Error('unexpected shared memory backing a document buffer');
  }
  return new Blob([new Uint8Array(underlying, bytes.byteOffset, bytes.byteLength)]);
}

// The one date format Stirling's metadata endpoint parses; anything else is rejected as malformed.
function stirlingDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function truncate(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// A Stirling without the tesseract data for a language answers one line about the format of the
// request, which is the one thing that was not wrong with it. Say what was actually asked for and
// where the data comes from: the instance recognises nothing in that language until its image
// carries it (deploy/stirling, ADR-018).
function missingLanguageData(error: unknown, languages: readonly string[]): Error | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('Invalid OCR languages format')) return null;

  return new Error(
    `Stirling has no tesseract data for ${languages.join(', ')} — rebuild it from deploy/stirling ` +
      `so it carries the languages this archive meets (${message})`,
  );
}

// Stirling describes every embedded image in place — `<image redacted: 596x842px, ~72dpi, JPG, …>`.
// That is a note about the file, not text from the document, and leaving it in would be worse than
// noise: a scanned page is *only* images, so the placeholders would pass the "has a text layer"
// threshold and the document would never be sent to OCR (docs/05 §5.5).
function stripImagePlaceholders(markdown: string): string {
  return markdown.replace(/<image redacted:[^>]*>/g, '');
}

// Beyond this a table cell is not data but a page laid out with table borders — tickets, invoices
// and forms are routinely built that way, and the converter faithfully reports the whole page as one
// two-cell table. Real tabular cells are short: a station name, a time, a seat number.
const MAX_DATA_CELL_CHARS = 160;

// Markdown tables the converter invented for a page whose *layout* is a table become paragraphs
// again, in reading order. A genuine table — short cells — is left exactly as it is, because that
// structure is worth keeping (docs/05 §5.5).
function unwrapLayoutTables(markdown: string): string {
  const out: string[] = [];
  let block: string[] = [];

  const flush = (): void => {
    if (block.length > 0) out.push(...renderTableBlock(block));
    block = [];
  };

  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('|')) block.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();

  return out.join('\n');
}

function renderTableBlock(rows: string[]): string[] {
  const cells = rows.filter((row) => !isSeparatorRow(row)).map(splitRow);
  const longest = Math.max(0, ...cells.flat().map((cell) => cell.length));
  if (longest <= MAX_DATA_CELL_CHARS) return rows;

  // Row by row, cell by cell — the order the text was read in — with a blank line between, so what
  // was a wall of table markup reads as paragraphs.
  return cells
    .flat()
    .filter((cell) => cell !== '')
    .flatMap((cell) => [cell, '']);
}

// 🔒 Trimmed first, and then one quantifier over one character class (docs/05 §5.5). What stood here
// — `/^\s*\|[\s:|-]+\|?\s*$/` — had three quantifiers that all accept a space, so a run of them
// could be divided between `[\s:|-]+` and the trailing `\s*` in every way there is: measured
// polynomial, 16 000 spaces after the pipe taking 167 ms and 64 000 taking 2.7 s, which puts a
// megabyte-long line at roughly ten minutes of a Markdown worker pinned to a core. The line is
// Markdown derived from a PDF somebody uploaded. The form below cannot backtrack across
// alternatives because there are none: it is linear, and a megabyte costs about a millisecond.
const SEPARATOR_ROW = /^\|[\s:|-]*$/;

function isSeparatorRow(row: string): boolean {
  return SEPARATOR_ROW.test(row.trim());
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}
