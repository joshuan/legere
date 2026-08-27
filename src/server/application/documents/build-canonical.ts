import type { PageFormat } from '../../../shared/contracts/enums';
import type { Document } from '../../domain/entities/document';
import {
  effectiveTurn,
  samePages,
  withExpandedPages,
  type DocumentPage,
} from '../../domain/entities/document-page';
import { classifyFormat, type DocumentFormat } from '../../domain/entities/document-format';
import { pageGeometryOf, type SourceShape } from '../../domain/entities/document-page-geometry';
import { hasUsableTextLayer } from '../../domain/entities/document-text';
import { ocrLanguagesOf } from '../../domain/entities/document-language';
import type { File } from '../../domain/entities/file';
import type {
  DocumentPageWithFile,
  FileRepository,
} from '../../domain/repositories/file.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { MAX_BINARY_BYTES, toBuffer, type BinarySource } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { LibraryReader } from '../ports/library-reader';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import type { ProcessingSettings } from '../jobs/processing-settings';
import type { QueueSettings } from '../queue/queue-settings';
import { originalKeyOf } from '../storage/artifact-keys';

// Step 1 of the pipeline, on its own (docs/05 §5.5): the pages of a document, in their order, become
// one PDF. Six passes — every file opened once and its pages counted, every page turned into a part,
// the parts merged, a text layer ensured, the format applied, the metadata stamped — and the result
// is the canonical, which every later step reads and nothing else.
//
// Written as a service rather than as a method of the job handler because it is the one part of the
// pipeline that knows what a document is *made of*; the handler knows what a document has *been
// through*.

// What came out. `unsupported` counts the files that contributed no page: the step is done and
// incomplete, which is a different thing from failed (docs/05 §5.5 step 1).
export type CanonicalBuild =
  | {
      kind: 'built';
      pdf: Buffer;
      pageCount: number;
      // Whether the text layer had to be recognised rather than read. This is where `ocrUsed` is
      // decided; until this release the OCR pass was run and thrown away (docs/05 §5.5).
      ocrUsed: boolean;
      unsupported: number;
    }
  // Nothing in this document can be rendered — every file is a format nothing opens, or there are
  // no pages at all. The canonical is not built, and it is nobody's failure.
  | { kind: 'nothingToBuild'; unsupported: number };

// One part of the canonical. `shape` is the picture it came from, when it came from one — the pages
// of a PDF or of an office document were laid out by whoever produced them, and this pipeline does
// not second-guess that (docs/05 §5.5 step 1).
type Part = { pdf: Buffer; shape: SourceShape | null };

// One file, opened once: what it is, and how many pages are inside it. A file nothing can render
// holds none and contributes nothing.
type OpenedFile =
  | { kind: 'image'; bytes: Buffer; pageCount: 1 }
  | { kind: 'pdf'; pdf: Buffer; pageCount: number }
  | { kind: 'unsupported' };

// A run of consecutive entries that can be taken out of one file in one go: same file, no crop, and
// therefore nothing that has to be rendered. A forty-page scan read straight through is one run.
type Run = { file: File; opened: OpenedFile; pages: DocumentPage[] };

// What a cropped page of a PDF is rendered at before its quadrilateral is applied. 300 dpi is what
// the recognizer reads best at, and a page arriving here is about to be recognised (docs/05 §5.5).
const CROPPED_PAGE_DPI = 300;

// 🔒 What every part of one document may weigh, added up (docs/05 §5.4a). `MAX_BINARY_BYTES` bounds
// one file and one answer; nothing bounded the *sum*, and this step holds every converted part at
// once — `inBatches` decides how many convert in parallel and nothing decides how many are retained,
// so the peak was a document's file count times whatever each of them weighed. Eighteen PDFs near
// `UPLOAD_MAX_BYTES` is ~1.8 GB of parts held before `mergePdfs` is even called, against a container
// given 2 GB (docs/12 §12.7), in the process that is also the HTTP surface (ADR-002).
//
// The same 256 MiB, because it is the same bound one level up: the merge hands the parts to Stirling
// and reads the answer back under `MAX_BINARY_BYTES`, so a document whose parts weigh more than this
// could never have produced a canonical anyway. What changes is where it finds out — before 1.8 GB
// is allocated instead of after.
const MAX_PARTS_BYTES = MAX_BINARY_BYTES;

export class BuildCanonical {
  constructor(
    private readonly files: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly storage: FileStorage,
    private readonly images: ImageTool,
    private readonly pdfs: PdfToolbox,
    private readonly queueSettings: QueueSettings,
    private readonly settings: ProcessingSettings,
  ) {}

  async execute(document: Document): Promise<CanonicalBuild> {
    const held = await this.files.listPagesForDocument(document.id);
    if (held.length === 0) return { kind: 'nothingToBuild', unsupported: 0 };

    // The files are independent work — read one, convert one, count one — so they are opened
    // `unitConcurrency` at a time (docs/05 §5.4). Read per run rather than at start-up: the knob
    // takes effect on the next document, with no worker to re-register (docs/11 §11.13).
    const { unitConcurrency } = await this.queueSettings.read();
    const distinct = distinctFilesOf(held);
    // 🔒 Asked of the sizes already written down, before a single file is opened — the same order
    // `HandleFileIngest` refuses an oversized file in, and for the same reason: a bound that fires
    // after the bytes are in memory is not a bound (docs/05 §5.4a).
    refuseOversizedDocument(distinct);
    const openedList = await inBatches(distinct, unitConcurrency, (file) => this.open(file));
    const opened = new Map(distinct.map((file, index) => [file.id, openedList[index]]));

    const unsupported = openedList.filter((one) => one?.kind === 'unsupported').length;
    await this.recordCounts(distinct, opened);
    const pages = await this.expand(document.id, held, opened);

    const runs = runsOf(pages, opened);
    // And again on the way out, because a conversion decides its own size: an office document is a
    // few kilobytes of XML and a hundred megabytes of PDF, so the sum of the sources is a floor on
    // what the parts weigh rather than a ceiling (docs/05 §5.4a). Counted as each batch lands, so
    // the refusal costs the batch that crossed the line and never the whole document's worth.
    const parts = await inBatches(runs, unitConcurrency, (run) => this.partOf(run), weighParts);
    const built = parts.filter((part): part is Part => part !== null);
    if (built.length === 0) return { kind: 'nothingToBuild', unsupported };

    const merged =
      built.length === 1
        ? (built[0]?.pdf ?? Buffer.alloc(0))
        : await this.pdfs.mergePdfs(built.map((part) => part.pdf));
    const pageCount = await this.pdfs.pdfPageCount(merged);
    const readable = await this.ensureTextLayer(document, merged, pageCount);

    // 🔒 The format is applied *after* the text layer exists, never before. Recognition happens in
    // the shape the page was made in — a page that is half white margin defeats the recognizer
    // outright — and the text it produces is vector, so it survives the page being scaled. That
    // ordering is what lets one archive be strictly A4 and searchable at the same time
    // (docs/05 §5.5 step 1).
    const shaped = await this.applyFormat(
      readable.pdf,
      built.flatMap((part) => (part.shape === null ? [] : [part.shape])),
      document.pageFormat,
    );

    return {
      kind: 'built',
      pdf: await this.stamp(document, shaped),
      pageCount,
      ocrUsed: readable.ocrUsed,
      unsupported,
    };
  }

  // Pass 1: one file, opened once. An image is one page; a PDF is what its page tree says; anything
  // with a printed form is converted and the conversion's pages are what it holds; a format nothing
  // can render holds none (docs/05 §5.5 step 1).
  private async open(file: File): Promise<OpenedFile> {
    const format: DocumentFormat = classifyFormat(file.mimeType);

    if (format === 'IMAGE') {
      return { kind: 'image', bytes: await toBuffer(await this.read(file)), pageCount: 1 };
    }

    if (format === 'PDF') {
      const pdf = await toBuffer(await this.read(file));
      return { kind: 'pdf', pdf, pageCount: await this.pdfs.pdfPageCount(pdf) };
    }

    if (format === 'OFFICE' || format === 'TEXT') {
      // The converter picks its input filter from the extension, so the file keeps its own name.
      const pdf = await this.pdfs.toPdf({ body: await this.read(file), fileName: file.name });
      return { kind: 'pdf', pdf, pageCount: await this.pdfs.pdfPageCount(pdf) };
    }

    return { kind: 'unsupported' };
  }

  // What every build that opens a file writes down: how many pages are inside it (docs/03 §3.3.16).
  // This is the only moment anything knows, and it is what lets an edit refuse a page index later
  // without a round trip of its own.
  private async recordCounts(
    files: readonly File[],
    opened: ReadonlyMap<string, OpenedFile | undefined>,
  ): Promise<void> {
    for (const file of files) {
      const one = opened.get(file.id);
      if (one === undefined || one.kind === 'unsupported') continue;
      if (one.pageCount === file.pageCount) continue;
      await this.files.recordPageCount(file.id, one.pageCount);
    }
  }

  // 🔒 The end of the one two-level state (ADR-025): an entry standing for a file whole becomes one
  // entry per page, now that the pages have been counted. Written down, so it happens once; a file
  // nothing could count keeps the entry it has, because a document is not made smaller by a format
  // we cannot read.
  private async expand(
    documentId: string,
    pages: readonly DocumentPageWithFile[],
    opened: ReadonlyMap<string, OpenedFile | undefined>,
  ): Promise<DocumentPageWithFile[]> {
    const counts = new Map<string, number>();
    for (const [fileId, one] of opened) {
      if (one === undefined || one.kind === 'unsupported') continue;
      counts.set(fileId, one.pageCount);
    }

    const expanded = withExpandedPages(pages, counts);
    if (samePages(pages, expanded)) return [...pages];

    await this.files.replacePages(documentId, expanded);
    return this.files.listPagesForDocument(documentId);
  }

  // Pass 2: one run of pages, one part. A page of an image is cropped, turned and corrected; a run
  // of uncropped pages of a PDF is taken out of the file in one selection and turned; a cropped page
  // of a PDF is rendered and then follows the image path (docs/05 §5.5 step 1).
  private async partOf(run: Run): Promise<Part | null> {
    const opened = run.opened;
    if (opened.kind === 'unsupported') return null;

    const first = run.pages[0];
    if (first === undefined) return null;

    if (opened.kind === 'image') return this.picturePart(opened.bytes, first, run.file.ext);

    if (first.crop !== null) {
      if (first.pageIndex === null || first.pageIndex >= opened.pageCount) return null;
      // 🔒 A crop on a page of a PDF is honoured exactly as a crop on an image is: the page is
      // rendered and warped, because a scanned page is already raster and loses nothing by it and a
      // vector page cropped becomes raster, which is what somebody who dragged its corners asked for
      // (docs/03 §3.3.17). The correction is not applied — it undoes what a camera does to a sheet,
      // and a page of a PDF was laid out by whoever produced it (docs/05 §5.5 step 1).
      const rendered = await this.pdfs.pdfPageJpg(opened.pdf, {
        page: first.pageIndex + 1,
        dpi: CROPPED_PAGE_DPI,
      });
      return this.picturePart(rendered, first, 'jpg', { correct: false });
    }

    // An entry naming a page the file does not hold — a count that has moved under it, a row written
    // by another version — contributes nothing, and the rest of the document stands (docs/05 §5.5).
    const wanted = run.pages.flatMap((page) =>
      page.pageIndex === null || page.pageIndex >= opened.pageCount ? [] : [page],
    );
    if (wanted.length === 0) return null;

    // The whole file in its own order is already the part: nothing there is worth a call for.
    const indices = wanted.map((page) => page.pageIndex ?? 0);
    const whole = indices.length === opened.pageCount && indices.every((index, at) => index === at);
    const selected = whole ? opened.pdf : await this.pdfs.rearrangePages(opened.pdf, indices);

    // The selection first, then the turns: each entry names its own page and its own turn, so what
    // is turned is exactly what was picked, however it was picked (docs/05 §5.5 step 1).
    const turns = wanted.map((page) => effectiveTurn(page)?.quarterTurns ?? 0);
    if (turns.every((turn) => turn === 0)) return { pdf: selected, shape: null };
    return { pdf: await this.pdfs.rotatePages(selected, turns), shape: null };
  }

  // A picture becomes one page: cropped, turned, corrected, laid on a page its own shape.
  //
  // 🔒 The turn comes after the crop and before the correction, and both halves of that are
  // deliberate. After the crop, because the stored quadrilateral is in the pixels that arrived
  // (docs/03 §3.3.17): turning first would leave every corner somebody dragged pointing at a
  // different part of the page. Before the correction, because the deskew reads the *rows* of a
  // page, which on a sheet still lying sideways run down it instead of across it (docs/05 §5.5).
  private async picturePart(
    bytes: Buffer,
    page: DocumentPage,
    ext: string,
    options: { correct?: boolean } = {},
  ): Promise<Part> {
    const framed = page.crop === null ? bytes : await this.images.applyCrop(bytes, page.crop);
    const turn = effectiveTurn(page);
    const stood = turn === null ? framed : await this.images.applyRotation(framed, turn);
    const mayCorrect = options.correct ?? true;
    const corrected =
      mayCorrect && this.settings.correctImagePages ? await this.correct(stood) : null;
    const rendered = corrected ?? stood;
    // Measured after all three, because that is what the page will be: a photograph taken at an
    // angle, straightened to the paper's own corners and stood upright is a sheet, whatever the
    // snapshot was.
    const shape = await this.images.dimensions(rendered);
    const rewritten = page.crop !== null || turn !== null || corrected !== null;
    return {
      pdf: await this.pdfs.imagesToPdf([
        { body: rendered, fileName: pageNameOf(page.position, rewritten, ext) },
      ]),
      shape,
    };
  }

  // Levelling the lighting and taking out the skew, best-effort like the format and the stamping
  // below: a filter that throws must not cost the document its page, because the uncorrected page is
  // still the page and a document lost over one is a poor trade (docs/05 §5.5 step 1). `null` — from
  // the port or from a failure — means the picture goes on as it arrived.
  private async correct(page: Buffer): Promise<Buffer | null> {
    try {
      return await this.images.correctPage(page);
    } catch {
      return null;
    }
  }

  // The merged PDF measured against the same threshold step 3 uses; below it the document is a scan
  // wearing a thin text layer, and the searchable PDF Stirling gives back becomes the canonical.
  // This is what makes a photographed page a text-selectable document (docs/05 §5.5 step 1).
  private async ensureTextLayer(
    document: Document,
    merged: Buffer,
    pageCount: number,
  ): Promise<{ pdf: Buffer; ocrUsed: boolean }> {
    const extracted = await this.pdfs.pdfToMarkdown(merged);
    if (hasUsableTextLayer(extracted, pageCount, this.settings.pdfTextMinCharsPerPage)) {
      return { pdf: merged, ocrUsed: false };
    }

    // The document's own languages once they are known, the instance default before that: a wrong
    // set costs accuracy, so a narrow one beats a broad one (docs/03 §3.3.10).
    const languages = ocrLanguagesOf(document.languages, this.settings.ocrLanguages);
    if (languages.length === 0) return { pdf: merged, ocrUsed: false };

    return { pdf: await this.pdfs.ocrPdf(merged, languages), ocrUsed: true };
  }

  // The last pass of step 1: every page onto the size this document is filed under. `null` means
  // the pages keep the shape they were built in — which is what a receipt, a panorama or a document
  // made of PDFs somebody else laid out should do (docs/05 §5.5 step 1).
  //
  // Best-effort like the stamping below: a document whose pages could not be resized is still the
  // document, and losing a finished canonical over the shape of its sheet would be a poor trade.
  private async applyFormat(
    pdf: Buffer,
    shapes: readonly SourceShape[],
    format: PageFormat,
  ): Promise<Buffer> {
    const geometry = pageGeometryOf(shapes, format);
    if (geometry.pageSize === null) return pdf;

    try {
      return await this.pdfs.scalePages(pdf, {
        pageSize: geometry.pageSize,
        orientation: geometry.orientation,
      });
    } catch {
      return pdf;
    }
  }

  // Best-effort, by the spec: a PDF with the wrong `/Title` is still the document, so a container
  // that refuses this leaves the canonical exactly as it was (docs/05 §5.5 step 1).
  private async stamp(document: Document, pdf: Buffer): Promise<Buffer> {
    try {
      return await this.pdfs.stampMetadata(pdf, {
        title: document.title,
        // What the paper says, when it says anything; otherwise the day this instance first saw it.
        date: documentDateOf(document),
      });
    } catch {
      return pdf;
    }
  }

  // Where a file's bytes are: in our own bucket for a managed file, on a volume for a library one
  // (docs/09 §9.1–9.2). Each call opens a fresh stream, because a stream is good for one read.
  //
  // Unlike the download route, the pipeline reads without a viewer: it is not answering anybody's
  // request, and a canonical built out of the files one person may see would be a different document
  // for each reader.
  private async read(file: File): Promise<BinarySource> {
    if (file.origin === 'MANAGED') return this.storage.getStream(originalKeyOf(file));

    const ref = await this.fileRefs.findLiveRefForFile(file.id);
    if (ref === null) {
      // The file vanished before the rebuild got to it. Throwing lets the job retry with backoff and
      // then surface in the failures list, rather than quietly writing a canonical missing a page.
      throw new Error(`The file "${file.name}" is not on any volume we can read`);
    }

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new Error(`The file "${file.name}" is in a library that no longer exists`);
    }

    return this.reader.openStream(
      { rootPath: library.rootPath, excludeGlobs: library.excludeGlobs },
      ref.path,
    );
  }
}

// The files a document's pages are read from, each once, in the order the pages first name them.
function distinctFilesOf(pages: readonly DocumentPageWithFile[]): File[] {
  const files: File[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.fileId)) continue;
    seen.add(page.fileId);
    files.push(page.file);
  }
  return files;
}

// The pages cut into runs: consecutive entries of one file that can be taken out of it together.
// A cropped page is a run of its own, because it is rendered rather than selected, and so is a page
// of an image, which is one page and one picture.
function runsOf(
  pages: readonly DocumentPageWithFile[],
  opened: ReadonlyMap<string, OpenedFile | undefined>,
): Run[] {
  const runs: Run[] = [];
  for (const page of pages) {
    const one: OpenedFile = opened.get(page.fileId) ?? { kind: 'unsupported' };
    const last = runs[runs.length - 1];
    const joinable =
      last !== undefined &&
      last.file.id === page.fileId &&
      last.opened.kind === 'pdf' &&
      one.kind === 'pdf' &&
      page.crop === null &&
      last.pages.every((held) => held.crop === null);
    if (joinable && last !== undefined) {
      last.pages.push(page);
      continue;
    }
    runs.push({ file: page.file, opened: one, pages: [page] });
  }
  return runs;
}

// The date on the paper, or failing that the day Legere first saw it: a `/CreationDate` is better
// wrong by a filing date than absent (docs/03 §3.3.10).
function documentDateOf(document: Document): Date | null {
  if (document.documentDate === null) return document.createdAt;
  const parsed = new Date(`${document.documentDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? document.createdAt : parsed;
}

// What the picture is called on its way into the converter. A page that was cropped, turned or
// corrected is JPEG now, whatever it arrived as, and Stirling reads the format from the name; one
// that came through untouched keeps its own bytes and therefore its own extension.
function pageNameOf(position: number, rewritten: boolean, ext: string): string {
  const at = String(position).padStart(4, '0');
  if (rewritten) return `page-${at}.jpg`;
  return `page-${at}.${ext === '' ? 'jpg' : ext}`;
}

// The sizes the archive already recorded, added up (docs/05 §5.4a). A `sizeBytes` is written when a
// file is ingested or uploaded and is the only thing here that can be known without opening
// anything, which is exactly what makes it worth asking first.
function refuseOversizedDocument(files: readonly File[]): void {
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0n);
  if (total > BigInt(MAX_PARTS_BYTES)) {
    throw new Error(
      `This document's ${files.length} files weigh ${total} bytes, past the ${MAX_PARTS_BYTES} ` +
        `bytes one canonical build may hold`,
    );
  }
}

// What the parts held so far weigh, refused past the budget. Given to `inBatches` as its watcher, so
// the count is taken once per batch rather than threaded through every caller.
function weighParts(parts: readonly (Part | null)[]): void {
  const total = parts.reduce((sum, part) => sum + (part?.pdf.byteLength ?? 0), 0);
  if (total > MAX_PARTS_BYTES) {
    throw new Error(
      `The pages of this document convert to ${total} bytes, past the ${MAX_PARTS_BYTES} bytes ` +
        `one canonical build may hold`,
    );
  }
}

// `size` at a time, in order, results in the order they went in. Written here rather than reached
// for from a library: it is six lines, and the alternative is a dependency for six lines.
//
// `watch` sees everything accumulated so far after each batch — which is what lets a bound on the
// *sum* fire while the sum is still small enough to be survivable (docs/05 §5.4a).
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
  watch?: (results: readonly R[]) => void,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) {
    results.push(...(await Promise.all(items.slice(index, index + Math.max(1, size)).map(work))));
    watch?.(results);
  }
  return results;
}
