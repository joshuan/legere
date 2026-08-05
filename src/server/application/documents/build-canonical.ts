import type { Document } from '../../domain/entities/document';
import { classifyFormat } from '../../domain/entities/document-format';
import { hasUsableTextLayer } from '../../domain/entities/document-text';
import { ocrLanguagesOf } from '../../domain/entities/document-language';
import type { File } from '../../domain/entities/file';
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

    const pages = parts.filter((part): part is Buffer => part !== null);
    const unsupported = parts.length - pages.length;
    if (pages.length === 0) return { kind: 'nothingToBuild', unsupported };

    // A single-part document skips the merge and keeps its part (docs/05 §5.5 step 1).
    const merged =
      pages.length === 1 ? (pages[0] ?? Buffer.alloc(0)) : await this.pdfs.mergePdfs(pages);
    const pageCount = await this.pdfs.pdfPageCount(merged);
    const readable = await this.ensureTextLayer(document, merged, pageCount);

    return {
      kind: 'built',
      pdf: await this.stamp(document, readable.pdf),
      pageCount,
      ocrUsed: readable.ocrUsed,
      unsupported,
    };
  }

  // One file, one part. An image becomes a page; a PDF is already pages; anything with a printed
  // form is converted; and a format nothing can render contributes nothing at all rather than
  // failing the document (docs/05 §5.5 step 1).
  private async partOf(file: DocumentFile): Promise<Buffer | null> {
    const format = classifyFormat(file.mimeType);

    if (format === 'PDF') return toBuffer(await this.open(file));

    if (format === 'IMAGE') {
      // The crop is applied here and nowhere else: the original file is never rewritten, and the
      // straightened page exists only inside the canonical (docs/03 §3.3.16).
      const page =
        file.crop === null
          ? await toBuffer(await this.open(file))
          : await this.images.applyCrop(await this.open(file), file.crop);
      return this.pdfs.imagesToPdf([{ body: page, fileName: pageNameOf(file) }]);
    }

    if (format === 'OFFICE' || format === 'TEXT') {
      // The converter picks its input filter from the extension, so the file keeps its own name.
      return this.pdfs.toPdf({ body: await this.open(file), fileName: file.name });
    }

    return null;
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

// What the image is called on its way into the converter. A cropped page is JPEG now, whatever it
// arrived as, and Stirling reads the format from the name.
function pageNameOf(file: DocumentFile): string {
  const position = String(file.position).padStart(4, '0');
  if (file.crop !== null) return `page-${position}.jpg`;
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
