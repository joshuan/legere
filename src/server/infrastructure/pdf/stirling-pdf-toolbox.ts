import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import {
  PdfToolbox,
  type FirstPageOptions,
  type NamedBinary,
} from '../../application/ports/pdf-toolbox';
import { AppConfig } from '../config/app-config';

// Stirling's REST surface (ADR-012). One endpoint per port method; the container is reached over the
// internal network and is never exposed.
const ENDPOINTS = {
  officeToPdf: '/api/v1/convert/file/pdf',
  pdfToImage: '/api/v1/convert/pdf/img',
  ocr: '/api/v1/misc/ocr-pdf',
  imagesToPdf: '/api/v1/convert/img/pdf',
  pageCount: '/api/v1/analysis/page-count',
  pdfToMarkdown: '/api/v1/convert/pdf/markdown',
} as const;

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

  async officeToPdf(source: NamedBinary): Promise<Buffer> {
    const form = new FormData();
    // LibreOffice picks its input filter from the extension, so the original name has to travel
    // with the bytes — an .xlsx uploaded as "file" would be read as something else entirely.
    form.append('fileInput', await blobOf(source.body), source.fileName);
    return this.postForBytes(ENDPOINTS.officeToPdf, form);
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
    return this.postForBytes(ENDPOINTS.pdfToImage, form);
  }

  async pdfToMarkdown(source: BinarySource): Promise<string> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');
    const bytes = await this.postForBytes(ENDPOINTS.pdfToMarkdown, form);
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
      return await this.postForBytes(ENDPOINTS.ocr, form);
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
    return this.postForBytes(ENDPOINTS.imagesToPdf, form);
  }

  async pdfPageCount(source: BinarySource): Promise<number> {
    const form = new FormData();
    form.append('fileInput', await blobOf(source), 'input.pdf');

    const response = await this.post(ENDPOINTS.pageCount, form);
    const parsed = pageCountSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Stirling returned an unreadable page count');
    return parsed.data.pageCount;
  }

  private async postForBytes(path: string, form: FormData): Promise<Buffer> {
    const response = await this.post(path, form);
    return Buffer.from(await response.arrayBuffer());
  }

  private async post(path: string, form: FormData): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST', body: form });
    if (!response.ok) {
      // The body carries Stirling's own message; it goes into the job error so the failure is
      // diagnosable from the admin panel instead of being just a status code.
      const detail = await response.text().catch(() => '');
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

function isSeparatorRow(row: string): boolean {
  return /^\s*\|[\s:|-]+\|?\s*$/.test(row);
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}
