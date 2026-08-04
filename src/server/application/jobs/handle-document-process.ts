import { z } from 'zod';
import {
  DOCUMENT_STEPS,
  documentStepSchema,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import type { Document, DocumentSteps } from '../../domain/entities/document';
import { chunkMarkdown } from '../../domain/entities/document-chunks';
import { detectLanguages } from '../../domain/entities/document-language';
import { classifyFormat, type DocumentFormat } from '../../domain/entities/document-format';
import { decodeText, hasUsableTextLayer, tidyMarkdown } from '../../domain/entities/document-text';
import type { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import type { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import type {
  DocumentRepository,
  ProcessingUpdate,
} from '../../domain/repositories/document.repository';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import { toBuffer, type BinarySource } from '../ports/binary-source';
import type { DocumentAnalysis, DocumentAnalyst } from '../ports/document-analyst';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { LibraryReader } from '../ports/library-reader';
import type { DocumentParser } from '../ports/document-parser';
import type { PdfToolbox } from '../ports/pdf-toolbox';
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

// How much of a document the analyst is shown. A documentType is decided by what a document is, which
// is visible in its first page or two — sending a 200-page contract would cost tokens for nothing.
const ANALYST_EXCERPT_CHARS = 4000;

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
// Markdown that makes a document searchable, and — when a provider is configured — its documentType and
// its vectors.
//
// Each step records its own status, so a failure is contained: a preview that cannot be rendered
// leaves the document listed, downloadable and still searchable. Re-running is safe — artifacts are
// overwritten in place and statuses are simply rewritten (docs/05 §5.4).
export class HandleDocumentProcess extends JobHandler {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: DocumentEventRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly files: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly parser: DocumentParser,
    private readonly images: ImageTool,
    private readonly documentTypes: DocumentTypeRepository,
    private readonly analyst: DocumentAnalyst,
    private readonly people: PersonRepository,
    private readonly subjects: SubjectRepository,
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
      // (docs/05 §5.5: SKIPPED for 1–3 and 5). Analysis still runs — a title is something to
      // classify — and, just as importantly, no step may be left PENDING: a document with a PENDING
      // step reads as "still processing" forever (docs/03 §3.3.10).
      await this.write(documentId, {
        steps: onlyRequested(
          {
            canonical: 'SKIPPED',
            preview: 'SKIPPED',
            markdown: 'SKIPPED',
            vectorization: 'SKIPPED',
          },
          requested,
        ),
        skipReasons: onlyRequested(
          {
            canonical: 'UNSUPPORTED_FORMAT',
            preview: 'UNSUPPORTED_FORMAT',
            markdown: 'UNSUPPORTED_FORMAT',
            vectorization: 'UNSUPPORTED_FORMAT',
          },
          requested,
        ),
        processingError: null,
        failedStep: null,
      });
      if (requested.has('analysis')) await this.analyse(document);
      return;
    }

    // A re-run starts from a clean slate: an error from a previous attempt must not outlive it.
    await this.write(documentId, {
      steps: onlyRequested(
        { canonical: 'PENDING', preview: 'PENDING', markdown: 'PENDING' },
        requested,
      ),
      skipReasons: onlyRequested({ canonical: null, preview: null, markdown: null }, requested),
      processingError: null,
      failedStep: null,
    });

    const openSource = await this.sourceOpener(document);
    const canonical = requested.has('canonical')
      ? await this.running(documentId, 'canonical', () =>
          this.canonicalize(document, format, openSource),
        )
      : // Not asked for: whatever step 1 produced earlier is still in the bucket, and the steps
        // after it must read that rather than the original office file (docs/07 §7.3).
        alreadyCanonical(document, format);

    // Step 2 asks Stirling how many pages there are; step 3 needs the same number to weigh the text
    // layer, so it is carried across rather than asked for twice.
    const pageCount = requested.has('preview')
      ? await this.running(documentId, 'preview', () =>
          this.renderPreviews(document, format, openSource, canonical),
        )
      : null;
    // Independent of the preview: a document whose page could not be rendered is still worth
    // reading and searching (docs/05 §5.5).
    if (requested.has('markdown')) {
      await this.running(documentId, 'markdown', () =>
        this.extractMarkdown(document, format, openSource, canonical, pageCount),
      );
    }

    // Steps 4 and 5 read what step 3 wrote, so the document is re-read rather than reusing the
    // stale copy this handler started with.
    const extracted = (await this.documents.findById(document.id)) ?? document;
    if (requested.has('analysis')) {
      await this.running(document.id, 'analysis', () => this.analyse(extracted));
    }
    if (requested.has('vectorization')) {
      await this.running(document.id, 'vectorization', () => this.vectorize(extracted));
    }
  }

  // Every write of a step's status, and the log entry that goes with it. Routed through one method
  // rather than recorded at each call site: there are a dozen of those, and a log is only worth
  // reading if nothing is missing from it (docs/03 §3.3.18).
  private async write(documentId: string, update: ProcessingUpdate): Promise<void> {
    await this.documents.updateProcessing(documentId, update);

    const steps = update.steps ?? {};
    for (const step of DOCUMENT_STEPS) {
      const status = steps[step];
      // PENDING is a re-run clearing the slate, which the QUEUED entry already says; undefined is a
      // step this write did not touch.
      if (status === undefined || status === 'PENDING') continue;
      const reason = update.skipReasons?.[step];
      await this.events.record({
        documentId,
        type: status === 'RUNNING' ? 'STEP_STARTED' : 'STEP_FINISHED',
        payload: {
          step,
          ...(status === 'RUNNING' ? {} : { status }),
          ...(reason === undefined || reason === null ? {} : { reason }),
          ...(status === 'FAILED' && update.processingError != null
            ? { error: update.processingError }
            : {}),
        },
      });
    }
  }

  // Says out loud that this step is being worked on, then lets the step settle its own outcome.
  // Without it a step that takes minutes — parsing with picture captions, OCR over a long scan, a
  // local model thinking — is indistinguishable from one that has not started, and the panel reads
  // as stuck (docs/03 §3.3.10). The mark is best-effort: it must never be the reason a job fails.
  private async running<T>(
    documentId: string,
    step: DocumentStep,
    work: () => Promise<T>,
  ): Promise<T> {
    const steps: Partial<DocumentSteps> = { [step]: 'RUNNING' };
    await this.write(documentId, { steps });
    return work();
  }

  // Step 1. Only office formats need converting; a PDF already is one, and images and text are
  // handled directly by the steps that follow (docs/05 §5.5).
  private async canonicalize(
    document: Document,
    format: DocumentFormat,
    openSource: OpenSource,
  ): Promise<Canonical> {
    if (format !== 'OFFICE') {
      await this.write(document.id, {
        steps: { canonical: 'SKIPPED' },
        skipReasons: { canonical: 'NOT_NEEDED' },
      });
      return format === 'TEXT' ? { kind: 'noPreview' } : { kind: 'sourceIsUsable' };
    }

    try {
      const pdf = await this.pdfs.officeToPdf({
        body: await openSource(),
        fileName: `${document.title}.${document.ext === '' ? 'bin' : document.ext}`,
      });
      await this.files.put(artifactKeys.canonicalPdf(document.id), pdf, 'application/pdf');
      await this.write(document.id, { steps: { canonical: 'DONE' } });
      return { kind: 'written' };
    } catch (error) {
      await this.recordFailure(document.id, 'canonical', error);
      return { kind: 'failed' };
    }
  }

  // Step 2. Both artifacts come from one rendered page, so a PDF is rasterized once and resized
  // twice (docs/09 §9.2: preview.jpg at PREVIEW_MAX_DIM, thumb.jpg at THUMB_MAX_DIM).
  // Returns the page count it learned on the way, or null when there was no PDF to ask about.
  private async renderPreviews(
    document: Document,
    format: DocumentFormat,
    openSource: OpenSource,
    canonical: Canonical,
  ): Promise<number | null> {
    if (canonical.kind === 'noPreview') {
      await this.write(document.id, {
        steps: { preview: 'SKIPPED' },
        skipReasons: { preview: 'NOT_NEEDED' },
      });
      return null;
    }

    if (canonical.kind === 'failed') {
      // Not a failure of its own: the page never existed to be rendered. The recorded error stays
      // the one from step 1 — replacing a root cause with its consequence helps nobody.
      await this.write(document.id, { steps: { preview: 'FAILED' } });
      return null;
    }

    try {
      // Both artifacts are made from the same bytes, and a stream can only be read once.
      const rendered =
        format === 'IMAGE'
          ? { page: await toBuffer(await openSource()), pageCount: null }
          : await this.renderFirstPage(document, canonical, openSource);
      const page = rendered.page;

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
      await this.write(document.id, { steps: { preview: 'DONE' } });
      return rendered.pageCount;
    } catch (error) {
      await this.recordFailure(document.id, 'preview', error);
      return null;
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
    pageCount: number | null,
  ): Promise<void> {
    if (canonical.kind === 'failed') {
      // The cause is already recorded against step 1; there is no canonical PDF to read.
      await this.write(document.id, { steps: { markdown: 'FAILED' } });
      return;
    }

    try {
      const { markdown, ocrUsed } =
        format === 'TEXT'
          ? { markdown: decodeText(await toBuffer(await openSource())), ocrUsed: false }
          : format === 'IMAGE'
            ? await this.ocrImage(document, openSource)
            : await this.readPdfText(document, canonical, openSource, pageCount);

      // What the document turned out to be written in — the set a later OCR pass is given
      // (docs/03 §3.3.10). Detected here because this is where the text first exists.
      const detected = detectLanguages(markdown);
      await this.write(document.id, {
        steps: { markdown: 'DONE' },
        // Empty means "nothing to read", which is different from "not extracted yet"; the column
        // stays null so search and the viewer can tell those apart.
        markdown: markdown === '' ? null : markdown,
        ocrUsed,
        languages: detected,
        // Kept separately as well, so a correction by hand can be shown for what it is: a
        // correction of this (docs/03 §3.3.10).
        auto: { languages: detected },
      });
    } catch (error) {
      await this.recordFailure(document.id, 'markdown', error);
    }
  }

  // A PDF is trusted to carry its own text only when there is enough of it: below
  // PDF_TEXT_MIN_CHARS_PER_PAGE on average the file is a scan wearing a thin text layer, and OCR is
  // what actually makes it readable (docs/05 §5.9).
  // Docling reads layout — headings, lists, real tables — and is the parser whenever it is
  // configured; Stirling's converter is the fallback for an instance running without it, and reads
  // text without structure (docs/05 §5.5).
  private async parseMarkdown(
    source: BinarySource,
    ocrLanguages: readonly string[],
  ): Promise<string> {
    if (this.parser.isConfigured) {
      // Docling recognises and parses in one pass, with the languages it was given.
      return tidyMarkdown(await this.parser.toMarkdown(source, { ocrLanguages }));
    }

    // The fallback needs two steps: Stirling OCRs into a searchable PDF, then converts it. Skipping
    // the first would silently leave every scan without any text at all.
    const readable =
      ocrLanguages.length === 0 ? source : await this.pdfs.ocrPdf(source, ocrLanguages);
    return tidyMarkdown(await this.pdfs.pdfToMarkdown(readable));
  }

  // Which languages the OCR pass is given: the document's own once they are known, the instance
  // default before that. A wrong set costs accuracy, so a narrow one beats a broad one
  // (docs/03 §3.3.10).
  private ocrLanguagesFor(document: Document): readonly string[] {
    const own = document.languages.flatMap(toTesseractCodes);
    return own.length > 0 ? own : this.settings.ocrLanguages;
  }

  private async readPdfText(
    document: Document,
    canonical: Canonical,
    openSource: OpenSource,
    knownPageCount: number | null,
  ): Promise<{ markdown: string; ocrUsed: boolean }> {
    const openPdf = this.pdfOpener(document, canonical, openSource);

    const extracted = await this.parseMarkdown(await openPdf(), []);
    // The preview step has usually recorded the page count by now; when it has not — a preview that
    // failed, a reprocess of this step alone — one more call answers it rather than guessing.
    const pageCount =
      knownPageCount ?? document.pageCount ?? (await this.pdfs.pdfPageCount(await openPdf()));
    if (hasUsableTextLayer(extracted, pageCount, this.settings.pdfTextMinCharsPerPage)) {
      return { markdown: extracted, ocrUsed: false };
    }

    // No usable text layer: the parser recognises the page instead of reading it.
    return {
      markdown: await this.parseMarkdown(await openPdf(), this.ocrLanguagesFor(document)),
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
    return {
      markdown: await this.parseMarkdown(asPdf, this.ocrLanguagesFor(document)),
      ocrUsed: true,
    };
  }

  // Renders page one and records how many pages there are — the count belongs to whichever PDF the
  // preview came from, source or canonical (docs/03 §3.3.10).
  private async renderFirstPage(
    document: Document,
    canonical: Canonical,
    openSource: OpenSource,
  ): Promise<{ page: Buffer; pageCount: number }> {
    const openPdf = this.pdfOpener(document, canonical, openSource);

    const pageCount = await this.pdfs.pdfPageCount(await openPdf());
    await this.write(document.id, { pageCount });
    return { page: await this.pdfs.pdfFirstPageJpg(await openPdf()), pageCount };
  }

  // Step 4. One look at the document: which of the active documentTypes it belongs to, and where it is
  // from. An unconfigured provider is not a failure — it is an instance that runs without AI at all
  // (docs/05 §5.5).
  private async analyse(document: Document): Promise<void> {
    // 🔒 A documentType a person chose is never overwritten by a machine (docs/03 §3.3.10).
    if (document.typeSource === 'MANUAL') {
      await this.write(document.id, {
        steps: { analysis: 'SKIPPED' },
        skipReasons: { analysis: 'MANUAL_TYPE' },
      });
      return;
    }
    if (!this.analyst.isConfigured) {
      await this.write(document.id, {
        steps: { analysis: 'SKIPPED' },
        skipReasons: { analysis: 'NOT_CONFIGURED' },
      });
      return;
    }

    try {
      const documentTypes = await this.documentTypes.listActive();
      const analysis = await this.analyst.analyze(
        analystExcerpt(document),
        documentTypes.map(({ slug: value, name, description }) => ({
          slug: value,
          name,
          description,
        })),
      );

      await this.linkPeople(document, analysis.people);
      await this.linkSubjects(document, analysis.subjects);

      // Second guard against a hallucinated slug: whatever came back has to match a documentType that
      // actually exists, or the document simply has none (docs/05 §5.5 step 4).
      const chosen =
        documentTypes.find((documentType) => documentType.slug === analysis.typeSlug) ?? null;
      await this.write(document.id, {
        steps: { analysis: 'DONE' },
        typeId: chosen?.id ?? null,
        typeSource: chosen === null ? 'NONE' : 'AUTO',
        ...placeUpdate(document, analysis),
        // Recorded whether or not it was applied: a place somebody filled in by hand stays, and the
        // reader still gets to see what the machine read (docs/03 §3.3.10).
        auto: {
          ...(analysis.people.length > 0 ? { people: analysis.people } : {}),
          ...(analysis.date === null ? {} : { date: analysis.date }),
          ...(analysis.subjects.length > 0 ? { subjects: analysis.subjects } : {}),
          typeSlug: analysis.typeSlug,
          ...(analysis.languages.length > 0 ? { languages: analysis.languages } : {}),
          country: analysis.country,
          city: analysis.city,
        },
      });
    } catch (error) {
      await this.recordFailure(document.id, 'analysis', error);
    }
  }

  // Names the analyst read become links, and a name the catalogue has never seen becomes a row.
  // Creating is the point: an archive where the machine may only pick from what somebody already
  // typed would need somebody to type everything first (docs/03 §3.3.19). Matching is by name,
  // case-insensitively — the only identity a document offers.
  //
  // Fill-blanks-only, like the rest of the analysis: a document that already names people is one
  // where somebody has decided, so the answer is recorded and not applied.
  private async linkPeople(document: Document, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    const already = await this.people.listForDocument(document.id);
    if (already.length > 0) return;

    const ids: string[] = [];
    for (const name of names) {
      const existing = await this.people.findByName(name);
      ids.push(existing?.id ?? (await this.people.create({ name })).id);
    }
    await this.people.setForDocument(document.id, ids);
  }

  // The same rule as people: what the analysis read becomes rows and links when the document has
  // none, and is only recorded when somebody has already decided (docs/03 §3.3.20). Matching is on
  // (kind, name) case-insensitively, because that pair is what identifies a thing.
  private async linkSubjects(
    document: Document,
    subjects: readonly { kind: string; name: string }[],
  ): Promise<void> {
    if (subjects.length === 0) return;
    const already = await this.subjects.listForDocument(document.id);
    if (already.length > 0) return;

    const ids: string[] = [];
    for (const subject of subjects) {
      const existing = await this.subjects.findByKindAndName(subject.kind, subject.name);
      ids.push(existing?.id ?? (await this.subjects.create(subject)).id);
    }
    await this.subjects.setForDocument(document.id, ids);
  }

  // Step 5. Chunk the Markdown, embed the chunks, and replace the document's vectors wholesale.
  private async vectorize(document: Document): Promise<void> {
    if (!this.embeddings.isConfigured) {
      await this.write(document.id, {
        steps: { vectorization: 'SKIPPED' },
        skipReasons: { vectorization: 'NOT_CONFIGURED' },
      });
      return;
    }

    const markdown = document.markdown ?? '';
    if (markdown.trim() === '') {
      // Nothing to embed. Any vectors from an earlier run go too, so search cannot return a
      // document by text it no longer has.
      await this.replaceChunks(document.id, []);
      await this.write(document.id, {
        steps: { vectorization: 'SKIPPED' },
        skipReasons: { vectorization: 'NO_TEXT' },
      });
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
      await this.write(document.id, { steps: { vectorization: 'DONE' } });
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
    // Everything but a library file keeps its bytes in the bucket — a merged scan set, an upload
    // (docs/09 §9.2). Only a LIBRARY document sends us back to the volume.
    if (document.source !== 'LIBRARY') {
      return () => this.files.getStream(artifactKeys.source(document.id, document.ext));
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
    step: 'canonical' | 'preview' | 'markdown' | 'analysis' | 'vectorization',
    error: unknown,
  ): Promise<void> {
    await this.write(documentId, {
      steps: { [step]: 'FAILED' },
      processingError: error instanceof Error ? error.message : String(error),
      failedStep: step,
    });
  }
}

// What the analyst may add, and only that. It fills blanks: the offline detector reads scripts and
// n-grams and is better at that than a chat model, so a language it found stands; a place nobody has
// filled in is the analyst's to answer, and a place somebody did fill in is theirs to keep
// (docs/03 §3.3.10). Clearing a field is how you ask for it to be inferred again.
function placeUpdate(document: Document, analysis: DocumentAnalysis): ProcessingUpdate {
  return {
    ...(document.languages.length === 0 && analysis.languages.length > 0
      ? { languages: analysis.languages }
      : {}),
    ...(document.country === null && analysis.country !== null
      ? { country: analysis.country }
      : {}),
    ...(document.city === null && analysis.city !== null ? { city: analysis.city } : {}),
    ...(document.documentDate === null && analysis.date !== null
      ? { documentDate: analysis.date }
      : {}),
  };
}

// Title first: it is often the most telling thing about a document, and it is there even when the
// text layer is empty.
function analystExcerpt(document: Document): string {
  return [document.title, document.markdown ?? '']
    .join('\n\n')
    .trim()
    .slice(0, ANALYST_EXCERPT_CHARS);
}

// Keeps only the entries this run is allowed to write, so a subset reprocess never resets the
// status of a step it was not asked to touch.
// Reprocessing a subset must touch only the steps that were asked for — statuses and, for the same
// reason, the notes that explain them (docs/07 §7.3).
function onlyRequested<T>(
  values: Partial<Record<DocumentStep, T>>,
  requested: ReadonlySet<DocumentStep>,
): Partial<Record<DocumentStep, T>> {
  return Object.fromEntries(
    Object.entries(values).filter(([step]) => requested.has(documentStepSchema.parse(step))),
  );
}

// What step 1 left in the bucket on an earlier run, as far as the later steps are concerned.
function alreadyCanonical(document: Document, format: DocumentFormat): Canonical {
  if (format === 'TEXT') return { kind: 'noPreview' };
  if (format !== 'OFFICE') return { kind: 'sourceIsUsable' };
  // An office document with no canonical PDF has nothing for the later steps to read.
  return document.steps.canonical === 'DONE' ? { kind: 'written' } : { kind: 'failed' };
}

// BCP-47 as the product stores it → the codes tesseract knows. Serbian is the case that needs the
// script: `srp` is Cyrillic, `srp_latn` is not, and giving the wrong one costs every diacritic.
const TESSERACT_CODES: Readonly<Record<string, string>> = {
  ru: 'rus',
  en: 'eng',
  uk: 'ukr',
  bg: 'bul',
  de: 'deu',
  fr: 'fra',
  es: 'spa',
  it: 'ita',
  pl: 'pol',
  tr: 'tur',
  'sr-Cyrl': 'srp',
  'sr-Latn': 'srp_latn',
  sr: 'srp',
  hr: 'srp_latn',
  bs: 'srp_latn',
};

function toTesseractCodes(language: string): string[] {
  const code = TESSERACT_CODES[language];
  return code === undefined ? [] : [code];
}
