import { z } from 'zod';
import {
  DOCUMENT_STEPS,
  documentStepSchema,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import type { Document } from '../../domain/entities/document';
import { chunkMarkdown } from '../../domain/entities/document-chunks';
import { classifyFormat, type DocumentFormat } from '../../domain/entities/document-format';
import {
  decodeText,
  hasUsableTextLayer,
  markdownFromPages,
} from '../../domain/entities/document-text';
import type { CategoryRepository } from '../../domain/repositories/category.repository';
import type { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { toBuffer, type BinarySource } from '../ports/binary-source';
import type { DocumentClassifier } from '../ports/document-classifier';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { LibraryReader } from '../ports/library-reader';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import type { TextExtractor } from '../ports/text-extractor';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys } from '../storage/artifact-keys';
import { JobHandler } from './job-handler';
import type { ProcessingSettings } from './processing-settings';

export const documentProcessPayloadSchema = z.object({
  documentId: z.string().uuid(),
  // A reprocess may ask for a subset; an absent list means the whole pipeline (docs/07 §7.3).
  steps: z.array(documentStepSchema).min(1).optional(),
});
export type DocumentProcessPayload = z.infer<typeof documentProcessPayloadSchema>;

// Quality settings of docs/09 §9.2 — fixed by the spec rather than configurable.
const PREVIEW_QUALITY = 80;
const THUMB_QUALITY = 75;

// How much of a document the classifier is shown. A category is decided by what a document is, which
// is visible in its first page or two — sending a 200-page contract would cost tokens for nothing.
const CLASSIFIER_EXCERPT_CHARS = 4000;

// A source of bytes that can be read more than once: page count and rendering are two separate
// passes over the same file, and a stream survives only one of them.
type OpenSource = () => Promise<BinarySource>;

// What step 1 left behind for step 2 to work from.
type Canonical =
  | { kind: 'sourceIsUsable' } // PDF or image: the source itself feeds the preview
  | { kind: 'written' } // office: canonical.pdf is in the bucket
  | { kind: 'failed' } // conversion failed; anything needing the PDF cannot run
  | { kind: 'noPreview' }; // text: there is nothing to render

// `document-process`, all five steps (docs/05 §5.5): canonicalization to PDF, the JPG previews, the
// Markdown that makes a document searchable, and — when a provider is configured — its category and
// its vectors.
//
// Each step records its own status, so a failure is contained: a preview that cannot be rendered
// leaves the document listed, downloadable and still searchable. Re-running is safe — artifacts are
// overwritten in place and statuses are simply rewritten (docs/05 §5.4).
export class HandleDocumentProcess extends JobHandler {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly files: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly images: ImageTool,
    private readonly text: TextExtractor,
    private readonly categories: CategoryRepository,
    private readonly classifier: DocumentClassifier,
    private readonly chunks: DocumentChunkRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly unitOfWork: UnitOfWork,
    private readonly settings: ProcessingSettings,
  ) {
    super();
  }

  async handle(rawPayload: unknown): Promise<void> {
    const payload = documentProcessPayloadSchema.parse(rawPayload);
    const documentId = payload.documentId;
    // Which steps this run is allowed to touch. Everything outside the set keeps the status and the
    // artifact it already has (docs/07 §7.3: reprocess re-runs only the requested steps).
    const requested = new Set<DocumentStep>(payload.steps ?? DOCUMENT_STEPS);

    const document = await this.documents.findById(documentId);
    // Soft-deleted or gone between enqueue and delivery: nothing to process, and nothing to fail.
    if (document === null || document.deletedAt !== null) return;

    const format = classifyFormat(document.mimeType);
    if (format === 'UNSUPPORTED') {
      // No representation can be built, so the steps that would build one are settled here
      // (docs/05 §5.5: SKIPPED for 1–3 and 5). Categorization still runs — a title is something to
      // classify — and, just as importantly, no step may be left PENDING: a document with a PENDING
      // step reads as "still processing" forever (docs/03 §3.3.10).
      await this.documents.updateProcessing(documentId, {
        steps: onlyRequested(
          {
            canonical: 'SKIPPED',
            preview: 'SKIPPED',
            markdown: 'SKIPPED',
            vectorization: 'SKIPPED',
          },
          requested,
        ),
        processingError: null,
        failedStep: null,
      });
      if (requested.has('categorization')) await this.categorize(document);
      return;
    }

    // A re-run starts from a clean slate: an error from a previous attempt must not outlive it.
    await this.documents.updateProcessing(documentId, {
      steps: onlyRequested(
        { canonical: 'PENDING', preview: 'PENDING', markdown: 'PENDING' },
        requested,
      ),
      processingError: null,
      failedStep: null,
    });

    const openSource = await this.sourceOpener(document);
    const canonical = requested.has('canonical')
      ? await this.canonicalize(document, format, openSource)
      : // Not asked for: whatever step 1 produced earlier is still in the bucket, and the steps
        // after it must read that rather than the original office file (docs/07 §7.3).
        alreadyCanonical(document, format);

    if (requested.has('preview')) {
      await this.renderPreviews(document, format, openSource, canonical);
    }
    // Independent of the preview: a document whose page could not be rendered is still worth
    // reading and searching (docs/05 §5.5).
    if (requested.has('markdown')) {
      await this.extractMarkdown(document, format, openSource, canonical);
    }

    // Steps 4 and 5 read what step 3 wrote, so the document is re-read rather than reusing the
    // stale copy this handler started with.
    const extracted = (await this.documents.findById(document.id)) ?? document;
    if (requested.has('categorization')) await this.categorize(extracted);
    if (requested.has('vectorization')) await this.vectorize(extracted);
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

  // Step 3. Every format ends up as Markdown one way or another: text passes through, a PDF with a
  // usable text layer is read directly, and anything else — a scan, a photographed page — goes
  // through OCR (docs/05 §5.5).
  private async extractMarkdown(
    document: Document,
    format: DocumentFormat,
    openSource: OpenSource,
    canonical: Canonical,
  ): Promise<void> {
    if (canonical.kind === 'failed') {
      // The cause is already recorded against step 1; there is no canonical PDF to read.
      await this.documents.updateProcessing(document.id, { steps: { markdown: 'FAILED' } });
      return;
    }

    try {
      const { markdown, ocrUsed } =
        format === 'TEXT'
          ? { markdown: decodeText(await toBuffer(await openSource())), ocrUsed: false }
          : format === 'IMAGE'
            ? await this.ocrImage(document, openSource)
            : await this.readPdfText(document, canonical, openSource);

      await this.documents.updateProcessing(document.id, {
        steps: { markdown: 'DONE' },
        // Empty means "nothing to read", which is different from "not extracted yet"; the column
        // stays null so search and the viewer can tell those apart.
        markdown: markdown === '' ? null : markdown,
        ocrUsed,
      });
    } catch (error) {
      await this.recordFailure(document.id, 'markdown', error);
    }
  }

  // A PDF is trusted to carry its own text only when there is enough of it: below
  // PDF_TEXT_MIN_CHARS_PER_PAGE on average the file is a scan wearing a thin text layer, and OCR is
  // what actually makes it readable (docs/05 §5.9).
  private async readPdfText(
    document: Document,
    canonical: Canonical,
    openSource: OpenSource,
  ): Promise<{ markdown: string; ocrUsed: boolean }> {
    const openPdf = this.pdfOpener(document, canonical, openSource);

    const pages = await this.text.pdfTextByPage(await openPdf());
    if (hasUsableTextLayer(pages, this.settings.pdfTextMinCharsPerPage)) {
      return { markdown: markdownFromPages(pages), ocrUsed: false };
    }

    const searchable = await this.pdfs.ocrPdf(await openPdf(), this.settings.ocrLanguages);
    return {
      markdown: markdownFromPages(await this.text.pdfTextByPage(searchable)),
      ocrUsed: true,
    };
  }

  // An image has no text layer to weigh: it goes to OCR directly. Stirling OCRs PDFs, so the image
  // becomes a one-page PDF first — the same conversion a scan set does (docs/05 §5.6).
  private async ocrImage(
    document: Document,
    openSource: OpenSource,
  ): Promise<{ markdown: string; ocrUsed: boolean }> {
    const asPdf = await this.pdfs.imagesToPdf([
      { body: await openSource(), fileName: `${document.title}.${document.ext || 'jpg'}` },
    ]);
    const searchable = await this.pdfs.ocrPdf(asPdf, this.settings.ocrLanguages);
    return {
      markdown: markdownFromPages(await this.text.pdfTextByPage(searchable)),
      ocrUsed: true,
    };
  }

  // Renders page one and records how many pages there are — the count belongs to whichever PDF the
  // preview came from, source or canonical (docs/03 §3.3.10).
  private async renderFirstPage(
    document: Document,
    canonical: Canonical,
    openSource: OpenSource,
  ): Promise<Buffer> {
    const openPdf = this.pdfOpener(document, canonical, openSource);

    const pageCount = await this.pdfs.pdfPageCount(await openPdf());
    await this.documents.updateProcessing(document.id, { pageCount });

    return this.pdfs.pdfFirstPageJpg(await openPdf());
  }

  // Step 4. The classifier is offered the active categories and answers with one of their slugs.
  // An unconfigured provider is not a failure — it is an instance that runs without AI at all
  // (docs/05 §5.5).
  private async categorize(document: Document): Promise<void> {
    // 🔒 A category a person chose is never overwritten by a machine (docs/03 §3.3.10).
    if (document.categorySource === 'MANUAL') {
      await this.documents.updateProcessing(document.id, { steps: { categorization: 'SKIPPED' } });
      return;
    }
    if (!this.classifier.isConfigured) {
      await this.documents.updateProcessing(document.id, { steps: { categorization: 'SKIPPED' } });
      return;
    }

    try {
      const categories = await this.categories.listActive();
      if (categories.length === 0) {
        await this.documents.updateProcessing(document.id, {
          steps: { categorization: 'SKIPPED' },
        });
        return;
      }

      const slug = await this.classifier.classify(
        classifierExcerpt(document),
        categories.map(({ slug: value, name, description }) => ({
          slug: value,
          name,
          description,
        })),
      );

      // Second guard against a hallucinated slug: whatever came back has to match a category that
      // actually exists, or the document simply has none (docs/05 §5.5 step 4).
      const chosen = categories.find((category) => category.slug === slug) ?? null;
      await this.documents.updateProcessing(document.id, {
        steps: { categorization: 'DONE' },
        categoryId: chosen?.id ?? null,
        categorySource: chosen === null ? 'NONE' : 'AUTO',
      });
    } catch (error) {
      await this.recordFailure(document.id, 'categorization', error);
    }
  }

  // Step 5. Chunk the Markdown, embed the chunks, and replace the document's vectors wholesale.
  private async vectorize(document: Document): Promise<void> {
    if (!this.embeddings.isConfigured) {
      await this.documents.updateProcessing(document.id, { steps: { vectorization: 'SKIPPED' } });
      return;
    }

    const markdown = document.markdown ?? '';
    if (markdown.trim() === '') {
      // Nothing to embed. Any vectors from an earlier run go too, so search cannot return a
      // document by text it no longer has.
      await this.replaceChunks(document.id, []);
      await this.documents.updateProcessing(document.id, { steps: { vectorization: 'SKIPPED' } });
      return;
    }

    try {
      const pieces = chunkMarkdown(markdown, {
        targetChars: this.settings.chunkTargetChars,
        overlapChars: this.settings.chunkOverlapChars,
      });
      const vectors = await this.embeddings.embed(pieces);
      if (vectors.length !== pieces.length) {
        throw new Error(
          `Embeddings provider returned ${vectors.length} vectors for ${pieces.length} chunks`,
        );
      }

      await this.replaceChunks(
        document.id,
        pieces.map((content, index) => ({
          index,
          content,
          charCount: content.length,
          embedding: vectors[index] ?? [],
        })),
      );
      await this.documents.updateProcessing(document.id, { steps: { vectorization: 'DONE' } });
    } catch (error) {
      await this.recordFailure(document.id, 'vectorization', error);
    }
  }

  // Delete-then-insert in one transaction (docs/03 §3.3.11): a reader never sees a document with
  // half of one vectorization and half of another.
  private async replaceChunks(
    documentId: string,
    chunks: Parameters<DocumentChunkRepository['replaceForDocument']>[1],
  ): Promise<void> {
    await this.unitOfWork.run((tx) => this.chunks.replaceForDocument(documentId, chunks, tx));
  }

  // The PDF a step should work from: the canonical one for an office document, the source itself
  // for a PDF. Steps 2 and 3 both read it, each of them more than once.
  private pdfOpener(document: Document, canonical: Canonical, openSource: OpenSource): OpenSource {
    return canonical.kind === 'written'
      ? () => this.files.getStream(artifactKeys.canonicalPdf(document.id))
      : openSource;
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
    step: 'canonical' | 'preview' | 'markdown' | 'categorization' | 'vectorization',
    error: unknown,
  ): Promise<void> {
    await this.documents.updateProcessing(documentId, {
      steps: { [step]: 'FAILED' },
      processingError: error instanceof Error ? error.message : String(error),
      failedStep: step,
    });
  }
}

// Title first: it is often the most telling thing about a document, and it is there even when the
// text layer is empty.
function classifierExcerpt(document: Document): string {
  return [document.title, document.markdown ?? '']
    .join('\n\n')
    .trim()
    .slice(0, CLASSIFIER_EXCERPT_CHARS);
}

// Keeps only the entries this run is allowed to write, so a subset reprocess never resets the
// status of a step it was not asked to touch.
function onlyRequested(
  steps: Partial<Record<DocumentStep, 'PENDING' | 'SKIPPED'>>,
  requested: ReadonlySet<DocumentStep>,
): Partial<Record<DocumentStep, 'PENDING' | 'SKIPPED'>> {
  return Object.fromEntries(
    Object.entries(steps).filter(([step]) => requested.has(documentStepSchema.parse(step))),
  );
}

// What step 1 left in the bucket on an earlier run, as far as the later steps are concerned.
function alreadyCanonical(document: Document, format: DocumentFormat): Canonical {
  if (format === 'TEXT') return { kind: 'noPreview' };
  if (format !== 'OFFICE') return { kind: 'sourceIsUsable' };
  // An office document with no canonical PDF has nothing for the later steps to read.
  return document.steps.canonical === 'DONE' ? { kind: 'written' } : { kind: 'failed' };
}
