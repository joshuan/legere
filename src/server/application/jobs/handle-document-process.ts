import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DOCUMENT_STEPS,
  documentStepSchema,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import type { Document, DocumentSteps } from '../../domain/entities/document';
import { chunkMarkdown } from '../../domain/entities/document-chunks';
import { detectLanguages, ocrLanguagesOf } from '../../domain/entities/document-language';
import {
  hasUsableTextLayer,
  meaningfulChars,
  tidyMarkdown,
} from '../../domain/entities/document-text';
import type { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import type { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import type {
  DocumentRepository,
  ProcessingUpdate,
} from '../../domain/repositories/document.repository';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import type { BuildCanonical } from '../documents/build-canonical';
import type { BinarySource } from '../ports/binary-source';
import type { CallContext } from '../ports/call-context';
import type { StepSkipReason, StepStatus } from '../../../shared/contracts/enums';
import type { Clock } from '../ports/clock';
import type { DocumentAnalysis, DocumentAnalyst, PageImage } from '../ports/document-analyst';
import type { PageTranscriber, TranscriptionUsage } from '../ports/page-transcriber';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { DocumentParser } from '../ports/document-parser';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys } from '../storage/artifact-keys';
import type { AnalysisSettings } from '../settings/analysis-settings';
import { JobHandler } from './job-handler';
import type { ProcessingSettings } from './processing-settings';

export const documentProcessPayloadSchema = z.object({
  documentId: z.string().uuid(),
  // A reprocess may ask for a subset; an absent list means the whole pipeline (docs/07 §7.3).
  steps: z.array(documentStepSchema).min(1).optional(),
  // A person asking for this one document to be analysed however long it is (docs/05 §5.5 step 4).
  // The page limit exists so that nothing *unasked* spends minutes of a model on a book; being asked
  // is the whole difference, so it travels with the job rather than being inferred from the steps.
  analyseInFull: z.boolean().optional(),
});
export type DocumentProcessPayload = z.infer<typeof documentProcessPayloadSchema>;

// Quality settings of docs/09 §9.2 — fixed by the spec rather than configurable.
const PREVIEW_QUALITY = 80;
const THUMB_QUALITY = 75;

// What step 1 left behind for every step after it. There is one artifact now, whatever the document
// was made of, so the later steps have one question to ask: is the canonical there (ADR-021)?
type Canonical =
  | { kind: 'ready'; pageCount: number; ocrUsed: boolean }
  // Nothing in the document can be rendered: no page to preview, no text to read, and no failure
  // to report either (docs/05 §5.5 step 1).
  | { kind: 'nothing' }
  | { kind: 'failed' };

// What step 3 left for the two steps that read it (docs/05 §5.5). Both of them take the extracted
// Markdown as their input, so the state of the extraction is the first question either of them asks.
// `ready` includes a step 3 that ran and found no text at all: that is a fact about the document
// rather than a gap in the pipeline, and both steps go on running over it.
type Extraction =
  { kind: 'ready' } | { kind: 'failed' } | { kind: 'missing'; reason: StepSkipReason };

// `document-process`, all five steps (docs/05 §5.5): the canonical PDF built out of the document's
// files, the JPG previews of its first page, the Markdown that makes it searchable, and — when a
// provider is configured — its documentType and its vectors.
//
// Each step records its own status, so a failure is contained: a preview that cannot be rendered
// leaves the document listed, downloadable and still searchable. Re-running is safe — artifacts are
// overwritten in place and statuses are simply rewritten (docs/05 §5.4).
export class HandleDocumentProcess extends JobHandler {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: DocumentEventRepository,
    private readonly canonical: BuildCanonical,
    private readonly files: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly parser: DocumentParser,
    private readonly images: ImageTool,
    private readonly documentTypes: DocumentTypeRepository,
    private readonly analyst: DocumentAnalyst,
    private readonly transcriber: PageTranscriber,
    private readonly people: PersonRepository,
    private readonly subjects: SubjectRepository,
    private readonly subjectKinds: SubjectKindRepository,
    private readonly chunks: DocumentChunkRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly unitOfWork: UnitOfWork,
    private readonly calls: CallContext,
    private readonly analysisSettings: AnalysisSettings,
    private readonly settings: ProcessingSettings,
    private readonly clock: Clock,
  ) {
    super();
  }

  // 🔒 When each step in flight began, keyed by the id of the call it belongs to. Not one field: the
  // handler is a singleton and `QUEUE_CONCURRENCY_PROCESS` documents run through it at once, so a
  // single slot would have the second document overwrite the first — the first would then be told
  // the second's duration and the second none at all. The call id is already scoped to exactly one
  // step by `running()`, which is the same reason `requestId` uses it (docs/03 §3.3.18).
  private readonly startedAt = new Map<string, number>();

  async handle(rawPayload: unknown): Promise<void> {
    const payload = documentProcessPayloadSchema.parse(rawPayload);
    const documentId = payload.documentId;
    // Which steps this run is allowed to touch. Everything outside the set keeps the status and the
    // artifact it already has (docs/07 §7.3: reprocess re-runs only the requested steps).
    const requested = new Set<DocumentStep>(payload.steps ?? DOCUMENT_STEPS);

    const document = await this.documents.findById(documentId);
    // Soft-deleted or gone between enqueue and delivery: nothing to process, and nothing to fail.
    if (document === null || document.deletedAt !== null) return;

    // A re-run starts from a clean slate: an error from a previous attempt must not outlive it.
    await this.write(documentId, {
      // QUEUED rather than PENDING: the job doing the clearing is the job that will do the work, so
      // nothing here is unscheduled (docs/03 §3.3.10).
      steps: onlyRequested(
        { canonical: 'QUEUED', preview: 'QUEUED', markdown: 'QUEUED' },
        requested,
      ),
      // 🔒 Every step this run may touch, not only the three that build the canonical: a reason left
      // behind outlives the thing it explained. `TOO_MANY_PAGES` did exactly that — a document
      // analysed in full stayed marked as too long to analyse, and went on offering the button that
      // asks for it again (docs/03 §3.3.10).
      skipReasons: onlyRequested(
        {
          canonical: null,
          preview: null,
          markdown: null,
          analysis: null,
          vectorization: null,
        },
        requested,
      ),
      processingError: null,
      failedStep: null,
    });

    const canonical = requested.has('canonical')
      ? await this.running(documentId, 'canonical', () => this.buildCanonical(document))
      : // Not asked for: whatever step 1 produced earlier is still in the bucket, and every step
        // after it reads that (docs/07 §7.3).
        alreadyBuilt(document);

    if (requested.has('preview')) {
      await this.running(documentId, 'preview', () => this.renderPreviews(document, canonical));
    }
    // Independent of the preview: a document whose page could not be rendered is still worth
    // reading and searching (docs/05 §5.5).
    if (requested.has('markdown')) {
      await this.running(documentId, 'markdown', () => this.extractMarkdown(document, canonical));
    }

    // Steps 4 and 5 read what step 3 wrote, so the document is re-read rather than reusing the
    // stale copy this handler started with.
    const extracted = (await this.documents.findById(document.id)) ?? document;
    if (requested.has('analysis')) {
      await this.running(document.id, 'analysis', () =>
        this.analyse(extracted, payload.analyseInFull ?? false),
      );
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
      // A step going back into the queue is a re-run clearing the slate, which the QUEUED entry
      // already says; undefined is a step this write did not touch.
      if (status === undefined || status === 'PENDING' || status === 'QUEUED') continue;
      const reason = update.skipReasons?.[step];
      // Which service is doing this step, and the id it was asked under. Both entries of a pair
      // carry the same id, because the id is read from the call in progress rather than passed
      // down: the frame that settles a step is a long way from the one that started it
      // (docs/03 §3.3.18).
      const requestId = this.calls.current;
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
          ...this.serviceOf(step),
          ...(requestId === null ? {} : { requestId }),
          ...this.cost(status),
          ...(update.metrics ?? {}),
        },
      });
    }
  }

  // What the step spent. Only on the entry that settles it: a step in progress has spent nothing
  // yet, and a duration on a RUNNING entry would be a duration of nothing (docs/03 §3.3.18).
  private cost(status: StepStatus): { durationMs?: number } {
    if (status === 'RUNNING') return {};
    const call = this.calls.current;
    const startedAt = call === null ? undefined : this.startedAt.get(call);
    if (call === null || startedAt === undefined) return {};
    // Removed as it is read: a step settles once, and a map that only grows is a leak in a process
    // that runs for months.
    this.startedAt.delete(call);
    return { durationMs: this.clock.now().getTime() - startedAt };
  }

  // Which service does a step, and where it lives. A step the pipeline does by itself — resizing an
  // image, chunking text — names none, because there is no other log to go and read
  // (docs/03 §3.3.18).
  private serviceOf(step: DocumentStep): { service?: string; endpoint?: string } {
    const stirling = { service: 'stirling', endpoint: this.pdfs.endpoint };
    if (step === 'canonical' || step === 'preview') return stirling;
    // Whichever one this instance actually parses with (docs/05 §5.5 step 3).
    if (step === 'markdown') {
      return this.parser.isConfigured
        ? { service: 'docling', endpoint: this.parser.endpoint }
        : stirling;
    }
    if (step === 'analysis') {
      return this.analyst.isConfigured
        ? { service: 'classifier', endpoint: this.analyst.endpoint }
        : {};
    }
    return this.embeddings.isConfigured
      ? { service: 'embeddings', endpoint: this.embeddings.endpoint }
      : {};
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
    // One id per step, generated here and carried by every request the step makes, so the entry in
    // the document's log can be looked up in the log of the service that did the work
    // (docs/03 §3.3.18).
    return this.calls.run(randomUUID(), async () => {
      const steps: Partial<DocumentSteps> = { [step]: 'RUNNING' };
      const call = this.calls.current;
      if (call !== null) this.startedAt.set(call, this.clock.now().getTime());
      await this.write(documentId, { steps });
      return work();
    });
  }

  // Step 1. One artifact for every document, always (ADR-021): the files in their order, cropped,
  // converted, merged, OCR'd if the text layer is thin, and stamped with what the document says it
  // is. The assembly itself lives in BuildCanonical; what belongs here is what it means for the row.
  private async buildCanonical(document: Document): Promise<Canonical> {
    try {
      const built = await this.canonical.execute(document);

      if (built.kind === 'nothingToBuild') {
        // A document of formats nothing can render: no artifact, no error, and every step that
        // would have read the artifact settles the same way (docs/05 §5.5 step 1).
        await this.write(document.id, {
          steps: { canonical: 'SKIPPED' },
          skipReasons: { canonical: 'UNSUPPORTED_FORMAT' },
          pageCount: null,
        });
        return { kind: 'nothing' };
      }

      await this.files.put(artifactKeys.canonicalPdf(document.id), built.pdf, 'application/pdf');
      await this.write(document.id, {
        steps: { canonical: 'DONE' },
        metrics: { pages: built.pageCount, ocrUsed: built.ocrUsed },
        // Some file of it contributed no page. The step is done and incomplete — which is a
        // different thing from failed, and worth saying out loud (docs/05 §5.5 step 1).
        skipReasons: { canonical: built.unsupported > 0 ? 'UNSUPPORTED_FORMAT' : null },
        // The count belongs to the canonical, because the canonical is the document (docs/03 §3.3.10).
        pageCount: built.pageCount,
        ocrUsed: built.ocrUsed,
      });
      return { kind: 'ready', pageCount: built.pageCount, ocrUsed: built.ocrUsed };
    } catch (error) {
      await this.recordFailure(document.id, 'canonical', error);
      return { kind: 'failed' };
    }
  }

  // Step 2. The first page of the canonical, rasterized once and resized twice (docs/09 §9.2:
  // preview.jpg at PREVIEW_MAX_DIM, thumb.jpg at THUMB_MAX_DIM). One rule for every document,
  // because by this point every document is a PDF.
  private async renderPreviews(document: Document, canonical: Canonical): Promise<void> {
    if (canonical.kind === 'nothing') {
      await this.write(document.id, {
        steps: { preview: 'SKIPPED' },
        skipReasons: { preview: 'UNSUPPORTED_FORMAT' },
      });
      return;
    }
    if (canonical.kind === 'failed') {
      // Not a failure of its own: the page never existed to be rendered. The recorded error stays
      // the one from step 1 — replacing a root cause with its consequence helps nobody.
      await this.write(document.id, { steps: { preview: 'FAILED' } });
      return;
    }

    try {
      const page = await this.pdfs.pdfPageJpg(await this.openCanonical(document));

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
    } catch (error) {
      await this.recordFailure(document.id, 'preview', error);
    }
  }

  // Step 3. The canonical PDF and nothing else: it is read where it carries text, and recognised
  // where step 1's OCR still found none (docs/05 §5.5 step 3).
  private async extractMarkdown(document: Document, canonical: Canonical): Promise<void> {
    if (canonical.kind === 'nothing') {
      await this.write(document.id, {
        steps: { markdown: 'SKIPPED' },
        skipReasons: { markdown: 'UNSUPPORTED_FORMAT' },
      });
      return;
    }
    if (canonical.kind === 'failed') {
      // The cause is already recorded against step 1; there is no canonical PDF to read.
      await this.write(document.id, { steps: { markdown: 'FAILED' } });
      return;
    }

    try {
      const read = await this.readCanonicalText(document, canonical);
      const ocrUsed = canonical.ocrUsed || read.ocrUsed;
      // A document that had to be *recognised* is a photograph or a scan, and that is exactly where
      // the cheap path has a floor no tuning lifts (docs/05 §5.5 step 3). One that arrived carrying
      // its own text layer is left alone: reading it is free and perfect, and no model improves on
      // perfect.
      const transcribed = ocrUsed
        ? await this.transcribePages(document, canonical.pageCount, read.markdown)
        : null;
      const markdown = transcribed?.markdown ?? read.markdown;

      // What the document turned out to be written in — the set a later OCR pass is given
      // (docs/03 §3.3.10). Detected here because this is where the text first exists.
      const detected = detectLanguages(markdown);
      await this.write(document.id, {
        steps: { markdown: 'DONE' },
        // 🔒 "It took four minutes" and "it returned nothing" are the two halves of one question,
        // and only one of them was ever written down (docs/03 §3.3.18).
        metrics: {
          chars: markdown.length,
          ocrUsed,
          ...(transcribed === null ? {} : { transcribed: true, ...transcribed.usage }),
        },
        // Empty means "nothing to read", which is different from "not extracted yet"; the column
        // stays null so search and the viewer can tell those apart.
        markdown: markdown === '' ? null : markdown,
        // Step 1 decides this for the artifact; a second recognition here can only add to it.
        ocrUsed: canonical.ocrUsed || ocrUsed,
        languages: detected,
        // Kept separately as well, so a correction by hand can be shown for what it is: a
        // correction of this (docs/03 §3.3.10).
        auto: { languages: detected },
      });
    } catch (error) {
      await this.recordFailure(document.id, 'markdown', error);
    }
  }

  // The recogniser of last resort (docs/05 §5.5 step 3). Everything about this is best-effort: an
  // unconfigured transcriber, a provider that refuses, a model that times out — all of them leave
  // the text that OCR already produced, which is what this product had before.
  //
  // 🔒 And a transcription shorter than what OCR already had is not kept. A model that could not see
  // the page — a refusal, a truncated answer, a blank — must not be able to empty a document that
  // was readable, and "it came back with less" is the one signal available before anybody reads it.
  private async transcribePages(
    document: Document,
    // 🔒 From the canonical that was just built, not from the row: the row this handler started with
    // was read before step 1 wrote the page count to it, and a stale zero here would silently mean
    // "no pages to show" — the failure that looks exactly like a disabled feature.
    pageCount: number,
    recognised: string,
  ): Promise<{ markdown: string; usage: TranscriptionUsage } | null> {
    if (!this.transcriber.isConfigured || this.settings.transcriberMaxPages === 0) return null;

    try {
      const pages = await this.renderPages(
        document,
        pageCount,
        this.settings.transcriberMaxPages,
        this.settings.transcriberPageImageMaxDim,
      );
      if (pages.length === 0) return null;

      const transcription = await this.transcriber.transcribe(pages, document.languages);
      const better = meaningfulChars(transcription.markdown) >= meaningfulChars(recognised);
      return better ? { markdown: transcription.markdown, usage: transcription.usage } : null;
    } catch {
      return null;
    }
  }

  private async readCanonicalText(
    document: Document,
    canonical: { pageCount: number },
  ): Promise<{ markdown: string; ocrUsed: boolean }> {
    const extracted = await this.parseMarkdown(await this.openCanonical(document), []);
    const pageCount = canonical.pageCount > 0 ? canonical.pageCount : (document.pageCount ?? 1);
    if (hasUsableTextLayer(extracted, pageCount, this.settings.pdfTextMinCharsPerPage)) {
      return { markdown: extracted, ocrUsed: false };
    }

    // A scan whose OCR pass in step 1 found nothing to read: the parser recognises the page instead
    // of reading it (docs/05 §5.5 step 3).
    return {
      markdown: await this.parseMarkdown(
        await this.openCanonical(document),
        ocrLanguagesOf(document.languages, this.settings.ocrLanguages),
      ),
      ocrUsed: true,
    };
  }

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
    // the first would silently leave a scan without any text at all.
    const readable =
      ocrLanguages.length === 0 ? source : await this.pdfs.ocrPdf(source, ocrLanguages);
    return tidyMarkdown(await this.pdfs.pdfToMarkdown(readable));
  }

  // The pages of the document as pictures, for the model to read beside the text — and to judge the
  // text against (docs/05 §5.5 step 4). A document is a picture before it is a string: a scan whose
  // recognition found nothing has no text to be analysed from at all, and the only reason nobody
  // noticed was that the step reported success over an empty result.
  //
  // Best-effort throughout: a page that will not render is a page the model does not get, and an
  // analysis on the text alone is worth more than a failed step.
  private pagesFor(document: Document): Promise<PageImage[]> {
    // Step 4 runs on a document read again after step 3, so both its page count and its canonical
    // status are current by then — which step 3, holding the row as it was before step 1 wrote to
    // it, cannot say of itself.
    if (document.steps.canonical !== 'DONE') return Promise.resolve([]);
    return this.renderPages(
      document,
      document.pageCount ?? 0,
      this.settings.analystMaxPageImages,
      this.settings.analystPageImageMaxDim,
    );
  }

  // The pages of the canonical as JPEGs, for whichever model is being shown them. Best-effort: a
  // page that will not render ends the sequence, and what has been rendered so far still goes — an
  // answer from the first three pages beats no answer at all.
  private async renderPages(
    document: Document,
    pageCount: number,
    limit: number,
    maxDim: number,
  ): Promise<PageImage[]> {
    const wanted = Math.min(pageCount, limit);
    if (wanted <= 0) return [];

    const pages: PageImage[] = [];
    for (let page = 1; page <= wanted; page += 1) {
      try {
        const rendered = await this.pdfs.pdfPageJpg(await this.openCanonical(document), { page });
        pages.push({ bytes: await this.images.toJpegPreview(rendered, { maxDim }) });
      } catch {
        break;
      }
    }
    return pages;
  }

  // 🔒 What steps 4 and 5 ask of step 3 before they ask anything of themselves (docs/05 §5.5).
  // Neither of them has an input of its own: they read the extracted Markdown, and a step that
  // reports `DONE` over text that was never produced — or over what an earlier run left behind,
  // since a failure deliberately does not clear the column — is worse than one that fails outright,
  // because only the second one is visible.
  //
  // True means the step has been settled here and must not run.
  private async blockedByExtraction(
    document: Document,
    step: 'analysis' | 'vectorization',
  ): Promise<boolean> {
    const extraction = extractionOf(document);
    if (extraction.kind === 'ready') return false;

    if (extraction.kind === 'failed') {
      // Not a failure of its own, so `processingError` and `failedStep` are left exactly as step 3
      // wrote them: a root cause replaced by its consequence is a root cause nobody can find. This
      // is what step 2 already does when step 1 fails (docs/03 §3.3.10).
      await this.write(document.id, { steps: { [step]: 'FAILED' } });
      return true;
    }

    await this.write(document.id, {
      steps: { [step]: 'SKIPPED' },
      skipReasons: { [step]: extraction.reason },
    });
    return true;
  }

  // Step 4. One look at the document: which of the active documentTypes it belongs to, and where it is
  // from. An unconfigured provider is not a failure — it is an instance that runs without AI at all
  // (docs/05 §5.5).
  private async analyse(document: Document, analyseInFull: boolean): Promise<void> {
    // 🔒 Asked before every gate of its own, so a forty-page document whose extraction failed reads
    // as a failed extraction rather than as one too long to analyse (docs/05 §5.5).
    if (await this.blockedByExtraction(document, 'analysis')) return;
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
    // 🔒 Past the limit the step does not analyse a shortened version — it does not analyse at all.
    // A verdict read off the first ten pages of a forty-page contract is worse than no verdict,
    // because it looks like one, and the document would carry a type and a title nobody could tell
    // were guesses (docs/05 §5.5 step 4). Asked for by a person, the whole of it goes.
    if (!analyseInFull && this.settings.analystAutoMaxPages > 0) {
      const pages = document.pageCount ?? 0;
      if (pages > this.settings.analystAutoMaxPages) {
        await this.write(document.id, {
          steps: { analysis: 'SKIPPED' },
          skipReasons: { analysis: 'TOO_MANY_PAGES' },
        });
        return;
      }
    }

    try {
      const documentTypes = await this.documentTypes.listActive();
      const kinds = await this.subjectKinds.listActive();
      const analysis = await this.analyst.analyze(
        analystExcerpt(document, this.settings.analystExcerptChars),
        documentTypes.map(({ slug: value, name, description }) => ({
          slug: value,
          name,
          description,
        })),
        kinds.map((kind) => kind.name),
        // Most documents are about something already here; the model can only know that if it is
        // shown the catalogue (docs/03 §3.3.20).
        (await this.subjects.listActive()).map((subject) => ({
          kind: subject.kind,
          name: subject.name,
          note: subject.note,
        })),
        // Read per run rather than at start-up: changing it takes effect on the next document
        // (docs/05 §5.5).
        (await this.analysisSettings.read()).language,
        await this.pagesFor(document),
      );

      await this.linkPeople(document, analysis.people);
      await this.linkSubjects(document, analysis.subjects);

      // Second guard against a hallucinated slug: whatever came back has to match a documentType that
      // actually exists, or the document simply has none (docs/05 §5.5 step 4).
      const chosen =
        documentTypes.find((documentType) => documentType.slug === analysis.typeSlug) ?? null;
      await this.write(document.id, {
        steps: { analysis: 'DONE' },
        metrics: { ...(analysis.usage ?? {}) },
        typeId: chosen?.id ?? null,
        typeSource: chosen === null ? 'NONE' : 'AUTO',
        ...titleUpdate(document, analysis),
        ...placeUpdate(document, analysis),
        // Recorded whether or not it was applied: a place somebody filled in by hand stays, and the
        // reader still gets to see what the machine read (docs/03 §3.3.10).
        auto: {
          ...(analysis.title === null ? {} : { title: analysis.title }),
          ...(analysis.description === null ? {} : { description: analysis.description }),
          ...(analysis.people.length > 0 ? { people: analysis.people } : {}),
          ...(analysis.date === null ? {} : { date: analysis.date }),
          ...(analysis.subjects.length > 0 ? { subjects: analysis.subjects } : {}),
          typeSlug: analysis.typeSlug,
          ...(analysis.languages.length > 0 ? { languages: analysis.languages } : {}),
          country: analysis.country,
          city: analysis.city,
          // Kept beside what the machine read, because it is a judgement about exactly that: how
          // much of the document the stored text actually is (docs/05 §5.5 step 4).
          ...(analysis.textQuality === null ? {} : { textQuality: analysis.textQuality }),
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
      // The kind is a catalogue row now (docs/03 §3.3.20a), and the analysis creates the one it
      // meets for the same reason it creates a person: an archive where the machine may only pick
      // from what somebody already typed would need somebody to type everything first.
      const kind =
        (await this.subjectKinds.findByName(subject.kind)) ??
        (await this.subjectKinds.create({ name: subject.kind }));
      const existing = await this.subjects.findByKindAndName(kind.id, subject.name);
      ids.push(
        existing?.id ?? (await this.subjects.create({ kindId: kind.id, name: subject.name })).id,
      );
    }
    await this.subjects.setForDocument(document.id, ids);
  }

  // Step 5. Chunk the Markdown, embed the chunks, and replace the document's vectors wholesale.
  private async vectorize(document: Document): Promise<void> {
    // 🔒 Before the provider check and before the empty-text one — and the one case where the stored
    // chunks are not touched at all. A run that learnt nothing about the document is no reason for a
    // findable document to stop being findable, which is why the stale Markdown stays searchable
    // too (docs/05 §5.5).
    if (await this.blockedByExtraction(document, 'vectorization')) return;
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

  // The one thing every step after the first reads (ADR-021). A fresh stream each time: a stream is
  // good for one read, and both the preview and the text extraction need their own.
  private openCanonical(document: Document): Promise<BinarySource> {
    return this.files.getStream(artifactKeys.canonicalPdf(document.id));
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

// The one field with no blank to fill: every document has a file name, so what governs the title is
// who decided it rather than whether it is empty. NONE is a file name and AUTO is the last run's
// answer — both may be improved on — and MANUAL is somebody's decision, which no machine touches
// (docs/03 §3.3.10).
function titleUpdate(document: Document, analysis: DocumentAnalysis): ProcessingUpdate {
  if (analysis.title === null || document.titleSource === 'MANUAL') return {};
  if (analysis.title === document.title) return {};
  return { title: analysis.title, titleSource: 'AUTO' };
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
    // A real blank, unlike the title: nobody writes one by accident, and clearing it is how you ask
    // for a new one (docs/03 §3.3.10).
    ...((document.description === null || document.description === '') &&
    analysis.description !== null
      ? { description: analysis.description }
      : {}),
  };
}

// Title first: it is often the most telling thing about a document, and it is there even when the
// text layer is empty.
// What the analyst reads: the document's name and the whole of its text. Capped only when an
// instance says so — `0` is no cap, and it is the default. The 4000 characters this used to take
// were the opening of a document, which is a letterhead: enough to tell a bank from a landlord and
// nothing like enough to tell one contract from another (docs/05 §5.5 step 4).
function analystExcerpt(document: Document, maxChars: number): string {
  const whole = [document.title, document.markdown ?? ''].join('\n\n').trim();
  return maxChars > 0 ? whole.slice(0, maxChars) : whole;
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

// What step 3 left behind, read off the row rather than off the copy the job started with — which
// is what makes the answer current for a full run and for a subset reprocess alike (docs/05 §5.5).
function extractionOf(document: Document): Extraction {
  const status = document.steps.markdown;
  if (status === 'DONE') return { kind: 'ready' };
  if (status === 'FAILED') return { kind: 'failed' };
  // A skip is inherited reason and all, so the reader is told the format could not be rendered
  // rather than that the embeddings found nothing (docs/03 §3.3.10).
  if (status === 'SKIPPED') {
    return { kind: 'missing', reason: document.skipReasons.markdown ?? 'NO_TEXT' };
  }
  // Still PENDING or QUEUED: what a reprocess asking for the analysis or the vectorization without
  // the extraction ever having run leaves behind, and "not extracted yet" is not text either.
  return { kind: 'missing', reason: 'NO_TEXT' };
}

// What step 1 left in the bucket on an earlier run, as far as the later steps are concerned.
function alreadyBuilt(document: Document): Canonical {
  if (document.steps.canonical === 'DONE') {
    return {
      kind: 'ready',
      pageCount: document.pageCount ?? 0,
      ocrUsed: document.ocrUsed,
    };
  }
  // Skipped means there was nothing to build from; anything else means it has not been built yet,
  // and a step reading an artifact that is not there would fail for the wrong reason.
  return document.steps.canonical === 'SKIPPED' ? { kind: 'nothing' } : { kind: 'failed' };
}
