import { z } from 'zod';
import type { Document } from '../../domain/entities/document';
import { classifyFormat, type DocumentFormat } from '../../domain/entities/document-format';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { toBuffer, type BinarySource } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { LibraryReader } from '../ports/library-reader';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import { artifactKeys } from '../storage/artifact-keys';
import { JobHandler } from './job-handler';
import type { ProcessingSettings } from './processing-settings';

export const documentProcessPayloadSchema = z.object({ documentId: z.string().uuid() });
export type DocumentProcessPayload = z.infer<typeof documentProcessPayloadSchema>;

// Quality settings of docs/09 §9.2 — fixed by the spec rather than configurable.
const PREVIEW_QUALITY = 80;
const THUMB_QUALITY = 75;

// A source of bytes that can be read more than once: page count and rendering are two separate
// passes over the same file, and a stream survives only one of them.
type OpenSource = () => Promise<BinarySource>;

// What step 1 left behind for step 2 to work from.
type Canonical =
  | { kind: 'sourceIsUsable' } // PDF or image: the source itself feeds the preview
  | { kind: 'written' } // office: canonical.pdf is in the bucket
  | { kind: 'failed' } // conversion failed; anything needing the PDF cannot run
  | { kind: 'noPreview' }; // text: there is nothing to render

// `document-process` steps 1–2 (docs/05 §5.5): canonicalization to PDF and the JPG previews.
//
// Each step records its own status, so a failure is contained: a preview that cannot be rendered
// leaves the document listed and downloadable, and the steps that do not depend on it still run.
// Re-running is safe — artifacts are overwritten in place and statuses are simply rewritten
// (docs/05 §5.4).
export class HandleDocumentProcess extends JobHandler {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly files: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly images: ImageTool,
    private readonly settings: ProcessingSettings,
  ) {
    super();
  }

  async handle(rawPayload: unknown): Promise<void> {
    const { documentId } = documentProcessPayloadSchema.parse(rawPayload);

    const document = await this.documents.findById(documentId);
    // Soft-deleted or gone between enqueue and delivery: nothing to process, and nothing to fail.
    if (document === null || document.deletedAt !== null) return;

    const format = classifyFormat(document.mimeType);
    if (format === 'UNSUPPORTED') {
      // No representation can be built, so the steps that would build one are settled now rather
      // than left PENDING forever (docs/05 §5.5). Step 4 is left alone: a title is still something
      // to categorize.
      await this.documents.updateProcessing(documentId, {
        steps: {
          canonical: 'SKIPPED',
          preview: 'SKIPPED',
          markdown: 'SKIPPED',
          vectorization: 'SKIPPED',
        },
        processingError: null,
        failedStep: null,
      });
      return;
    }

    // A re-run starts from a clean slate: an error from a previous attempt must not outlive it.
    await this.documents.updateProcessing(documentId, {
      steps: { canonical: 'PENDING', preview: 'PENDING' },
      processingError: null,
      failedStep: null,
    });

    const openSource = await this.sourceOpener(document);
    const canonical = await this.canonicalize(document, format, openSource);
    await this.renderPreviews(document, format, openSource, canonical);
  }

  // Step 1. Only office formats need converting; a PDF already is one, and images and text are
  // handled directly by the steps that follow (docs/05 §5.5).
  private async canonicalize(
    document: Document,
    format: DocumentFormat,
    openSource: OpenSource,
  ): Promise<Canonical> {
    if (format !== 'OFFICE') {
      await this.documents.updateProcessing(document.id, { steps: { canonical: 'SKIPPED' } });
      return format === 'TEXT' ? { kind: 'noPreview' } : { kind: 'sourceIsUsable' };
    }

    try {
      const pdf = await this.pdfs.officeToPdf({
        body: await openSource(),
        fileName: `${document.title}.${document.ext === '' ? 'bin' : document.ext}`,
      });
      await this.files.put(artifactKeys.canonicalPdf(document.id), pdf, 'application/pdf');
      await this.documents.updateProcessing(document.id, { steps: { canonical: 'DONE' } });
      return { kind: 'written' };
    } catch (error) {
      await this.recordFailure(document.id, 'canonical', error);
      return { kind: 'failed' };
    }
  }

  // Step 2. Both artifacts come from one rendered page, so a PDF is rasterized once and resized
  // twice (docs/09 §9.2: preview.jpg at PREVIEW_MAX_DIM, thumb.jpg at THUMB_MAX_DIM).
  private async renderPreviews(
    document: Document,
    format: DocumentFormat,
    openSource: OpenSource,
    canonical: Canonical,
  ): Promise<void> {
    if (canonical.kind === 'noPreview') {
      await this.documents.updateProcessing(document.id, { steps: { preview: 'SKIPPED' } });
      return;
    }

    if (canonical.kind === 'failed') {
      // Not a failure of its own: the page never existed to be rendered. The recorded error stays
      // the one from step 1 — replacing a root cause with its consequence helps nobody.
      await this.documents.updateProcessing(document.id, { steps: { preview: 'FAILED' } });
      return;
    }

    try {
      // Both artifacts are made from the same bytes, and a stream can only be read once.
      const page =
        format === 'IMAGE'
          ? await toBuffer(await openSource())
          : await this.renderFirstPage(document, canonical, openSource);

      const [preview, thumb] = await Promise.all([
        this.images.toJpegPreview(page, {
          maxDim: this.settings.previewMaxDim,
          quality: PREVIEW_QUALITY,
        }),
        this.images.toJpegPreview(page, {
          maxDim: this.settings.thumbMaxDim,
          quality: THUMB_QUALITY,
        }),
      ]);

      await this.files.put(artifactKeys.preview(document.id), preview, 'image/jpeg');
      await this.files.put(artifactKeys.thumbnail(document.id), thumb, 'image/jpeg');
      await this.documents.updateProcessing(document.id, { steps: { preview: 'DONE' } });
    } catch (error) {
      await this.recordFailure(document.id, 'preview', error);
    }
  }

  // Renders page one and records how many pages there are — the count belongs to whichever PDF the
  // preview came from, source or canonical (docs/03 §3.3.10).
  private async renderFirstPage(
    document: Document,
    canonical: Canonical,
    openSource: OpenSource,
  ): Promise<Buffer> {
    const openPdf: OpenSource =
      canonical.kind === 'written'
        ? () => this.files.getStream(artifactKeys.canonicalPdf(document.id))
        : openSource;

    const pageCount = await this.pdfs.pdfPageCount(await openPdf());
    await this.documents.updateProcessing(document.id, { pageCount });

    return this.pdfs.pdfFirstPageJpg(await openPdf());
  }

  // Where the document's own bytes live: in the library for a scanned file, in the bucket for a
  // scan-set result (docs/09 §9.1–9.2). Each call opens a fresh stream.
  private async sourceOpener(document: Document): Promise<OpenSource> {
    if (document.source === 'DERIVED') {
      return () => this.files.getStream(artifactKeys.derivedSource(document.id));
    }

    const ref = await this.fileRefs.findLiveRefForDocument(document.id);
    if (ref === null) {
      // The file vanished before processing got to it. Throwing lets the job retry with backoff and
      // then surface in the failures list, rather than silently marking the document unprocessable.
      throw new Error(`Document ${document.id} has no available file to process`);
    }

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new Error(`Document ${document.id} has no available library to read from`);
    }

    const location = { rootPath: library.rootPath, excludeGlobs: library.excludeGlobs };
    return () => this.reader.openStream(location, ref.path);
  }

  // `failedStep` names the step in the admin panel, and the step's own status turns FAILED — the
  // other steps keep their own outcomes (docs/05 §5.5).
  private async recordFailure(
    documentId: string,
    step: 'canonical' | 'preview',
    error: unknown,
  ): Promise<void> {
    await this.documents.updateProcessing(documentId, {
      steps: step === 'canonical' ? { canonical: 'FAILED' } : { preview: 'FAILED' },
      processingError: error instanceof Error ? error.message : String(error),
      failedStep: step,
    });
  }
}
