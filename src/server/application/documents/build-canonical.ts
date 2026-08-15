import type { PageFormat } from '../../../shared/contracts/enums';
import type { Document } from '../../domain/entities/document';
import { classifyFormat } from '../../domain/entities/document-format';
import { pageGeometryOf, type SourceShape } from '../../domain/entities/document-page-geometry';
import { hasUsableTextLayer } from '../../domain/entities/document-text';
import { ocrLanguagesOf } from '../../domain/entities/document-language';
import { effectivePageOrder, type File } from '../../domain/entities/file';
import type { DocumentFile, FileRepository } from '../../domain/repositories/file.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { toBuffer, type BinarySource } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { LibraryReader } from '../ports/library-reader';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import type { ProcessingSettings } from '../jobs/processing-settings';
import type { QueueSettings } from '../queue/queue-settings';
import { originalKeyOf } from '../storage/artifact-keys';

// Step 1 of the pipeline, on its own (docs/05 §5.5): the files of a document, in their order, become
// one PDF. Four passes — each file to a PDF part, the parts merged, a text layer ensured, the
// metadata stamped — and the result is the canonical, which every later step reads and nothing else.
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
  // no files at all. The canonical is not built, and it is nobody's failure.
  | { kind: 'nothingToBuild'; unsupported: number };

// One file, converted. `shape` is the picture it came from, when it came from one — the pages of a
// PDF or of an office document were laid out by whoever produced them, and this pipeline does not
// second-guess that (docs/05 §5.5 step 1).
type Part = { pdf: Buffer; shape: SourceShape | null };

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
    const files = await this.files.listForDocument(document.id);
    if (files.length === 0) return { kind: 'nothingToBuild', unsupported: 0 };

    // The files are independent work — read one, crop one, convert one — so they are prepared
    // `unitConcurrency` at a time (docs/05 §5.4). Read per run rather than at start-up: the knob
    // takes effect on the next document, with no worker to re-register (docs/11 §11.13).
    const { unitConcurrency } = await this.queueSettings.read();
    const ordered = [...files].sort((a, b) => a.position - b.position);
    const parts = await inBatches(ordered, unitConcurrency, (file) => this.partOf(file));

    const built = parts.filter((part): part is Part => part !== null);
    const unsupported = parts.length - built.length;
    if (built.length === 0) return { kind: 'nothingToBuild', unsupported };

    const pages = built.map((part) => part.pdf);
    // A single-part document skips the merge and keeps its part (docs/05 §5.5 step 1).
    const merged =
      pages.length === 1 ? (pages[0] ?? Buffer.alloc(0)) : await this.pdfs.mergePdfs(pages);
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

  // One file, one part. An image becomes a page; a PDF is already pages; anything with a printed
  // form is converted; and a format nothing can render contributes nothing at all rather than
  // failing the document (docs/05 §5.5 step 1).
  //
  // An image part also says what shape it was: the format of the finished canonical is read off the
  // pictures it was made from, and by the time the parts are merged that is no longer visible.
  private async partOf(file: DocumentFile): Promise<Part | null> {
    const format = classifyFormat(file.mimeType);

    if (format === 'PDF') return { pdf: await this.pdfPartOf(file), shape: null };

    if (format === 'IMAGE') {
      // The crop is applied here and nowhere else: the original file is never rewritten, and the
      // straightened page exists only inside the canonical (docs/03 §3.3.16).
      const framed =
        file.crop === null
          ? await toBuffer(await this.open(file))
          : await this.images.applyCrop(await this.open(file), file.crop);
      // 🔒 And the correction after the crop, never before it. The crop decides what the page *is*:
      // a photograph carries the desk it was lying on, and lighting levelled over the desk levels
      // the desk — the paper's own shading is then read as part of a much wider range and barely
      // touched. The crop also straightens the sheet, so what skew is left after it is the skew of
      // the page rather than of the snapshot (docs/05 §5.5 step 1, §5.6).
      const corrected = this.settings.correctImagePages ? await this.correct(framed) : null;
      const page = corrected ?? framed;
      // Measured after both, because that is what the page will be: a photograph taken at an angle
      // and straightened to the paper's own corners is a sheet, whatever the snapshot was.
      const shape = await this.images.dimensions(page);
      return {
        pdf: await this.pdfs.imagesToPdf([
          { body: page, fileName: pageNameOf(file, file.crop !== null || corrected !== null) },
        ]),
        shape,
      };
    }

    if (format === 'OFFICE' || format === 'TEXT') {
      // The converter picks its input filter from the extension, so the file keeps its own name.
      return {
        pdf: await this.pdfs.toPdf({ body: await this.open(file), fileName: file.name }),
        shape: null,
      };
    }

    return null;
  }

  // A PDF is already pages, so the part is the file — read in the order the file records, where it
  // records one (docs/05 §5.5 step 1.1).
  //
  // Its pages are counted here, every build, and the number written onto the row: this is the one
  // moment anything opens the file, and knowing how many pages it holds is what lets an edit refuse
  // a wrong order later without a round trip of its own (docs/03 §3.3.16). A stored order that does
  // not describe the pages just counted is ignored rather than fatal — the same treatment an
  // unreadable crop gets, and for the same reason: the document outranks the correction.
  //
  // 🔒 The rearranged bytes are the part and nothing else. The file is not rewritten, cannot be for
  // a LIBRARY original (ADR-007), and is not for a MANAGED one either.
  private async pdfPartOf(file: DocumentFile): Promise<Buffer> {
    const bytes = await toBuffer(await this.open(file));
    const pageCount = await this.pdfs.pdfPageCount(bytes);
    if (pageCount !== file.pageCount) await this.files.recordPageCount(file.id, pageCount);

    const order = effectivePageOrder(file, pageCount);
    if (order === null) return bytes;
    return this.pdfs.rearrangePages(bytes, order);
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
  private async open(file: File): Promise<BinarySource> {
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

// The date on the paper, or failing that the day Legere first saw it: a `/CreationDate` is better
// wrong by a filing date than absent (docs/03 §3.3.10).
function documentDateOf(document: Document): Date | null {
  if (document.documentDate === null) return document.createdAt;
  const parsed = new Date(`${document.documentDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? document.createdAt : parsed;
}

// What the image is called on its way into the converter. A page that was cropped or corrected is
// JPEG now, whatever it arrived as, and Stirling reads the format from the name; one that came
// through untouched keeps its own bytes and therefore its own extension.
function pageNameOf(file: DocumentFile, rewritten: boolean): string {
  const position = String(file.position).padStart(4, '0');
  if (rewritten) return `page-${position}.jpg`;
  return `page-${position}.${file.ext === '' ? 'jpg' : file.ext}`;
}

// `size` at a time, in order, results in the order they went in. Written here rather than reached
// for from a library: it is six lines, and the alternative is a dependency for six lines.
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) {
    results.push(...(await Promise.all(items.slice(index, index + Math.max(1, size)).map(work))));
  }
  return results;
}
