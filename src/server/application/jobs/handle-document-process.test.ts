import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  documentFixture,
  LIBRARY_ID,
  FakeAnalyst,
  FakeTranscriber,
  FakeCallContext,
  FakeDocumentEventRepository,
  InMemoryPersonRepository,
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
  FakeEmbeddingProvider,
  FakeImageTool,
  FakeDocumentParser,
  FakePdfToolbox,
  ImmediateUnitOfWork,
  InMemoryCategoryRepository,
  InMemoryDocumentChunkRepository,
  InMemoryDocumentRepository,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  InMemoryLibraryRepository,
  InMemorySettingsRepository,
  libraryFixture,
  queueSettingsFixture,
  StubLibraryReader,
} from '../../../../test/helpers/processing-fakes';
import type { Crop, DocumentStep, Rotation } from '../../../shared/contracts/documents';
import type { Document } from '../../domain/entities/document';
import { QUEUE_SETTINGS_KEY } from '../queue/queue-settings';
import type { File } from '../../domain/entities/file';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { BuildCanonical } from '../documents/build-canonical';
import { artifactKeys, originalKeyOf } from '../storage/artifact-keys';
import { AnalysisSettings } from '../settings/analysis-settings';
import { FixedClock } from '../../../../test/helpers/fakes';
import type { ProcessingSettings } from './processing-settings';
import { HandleDocumentProcess } from './handle-document-process';

const PREVIEW_MAX_DIM = 1600;
const THUMB_MAX_DIM = 400;
const MIN_CHARS_PER_PAGE = 32;
// Comfortably above the threshold, so the default PDF path is "has a text layer".
const TEXT_LAYER = 'Invoice 2026-01 for services rendered in January, payable within 30 days.';
const GONE_ID = '44444444-4444-4444-8444-444444444444';

// One page of a document: the file row, and the bytes behind it.
// One page of a document under test: which file it is read from, what the bytes say, and — since
// ADR-025 — what the page itself says about how it is read (docs/03 §3.3.17).
type PageSpec = { file?: Partial<File>; bytes?: string; crop?: Crop; turn?: Rotation };

// The whole pipeline of docs/05 §5.5 with the containers and the bucket replaced by in-memory
// doubles: what is asserted here is the assembly, the artifacts and the statuses — the ports
// themselves are covered by their own suites.
describe('HandleDocumentProcess', () => {
  let documents: InMemoryDocumentRepository;
  let fileRepo: InMemoryFileRepository;
  let events: FakeDocumentEventRepository;
  let fileRefs: InMemoryFileRefRepository;
  let libraries: InMemoryLibraryRepository;
  let reader: StubLibraryReader;
  let storage: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let parser: FakeDocumentParser;
  let images: FakeImageTool;
  let documentTypes: InMemoryCategoryRepository;
  let analyst: FakeAnalyst;
  let transcriber: FakeTranscriber;
  // Mutable, so a test can say what step 4 is allowed to be shown without rebuilding the handler.
  let settings: ProcessingSettings;
  let clock: FixedClock;
  let people: InMemoryPersonRepository;
  let subjects: InMemorySubjectRepository;
  let subjectKinds: InMemorySubjectKindRepository;
  let chunks: InMemoryDocumentChunkRepository;
  let embeddings: FakeEmbeddingProvider;
  let calls: FakeCallContext;
  let handler: HandleDocumentProcess;
  // The one settings row a pause lives in (docs/05 §5.4d), kept where the tests can write to it.
  let queueStore: InMemorySettingsRepository;

  beforeEach(() => {
    queueStore = new InMemorySettingsRepository();
    documents = new InMemoryDocumentRepository();
    fileRepo = new InMemoryFileRepository();
    events = new FakeDocumentEventRepository();
    fileRefs = new InMemoryFileRefRepository();
    libraries = new InMemoryLibraryRepository();
    reader = new StubLibraryReader();
    storage = new InMemoryFileStorage();
    pdfs = new FakePdfToolbox();
    parser = new FakeDocumentParser();
    images = new FakeImageTool();
    pdfs.defaultMarkdown = TEXT_LAYER;
    // What OCR produces, so an OCR'd document reads differently from one with a text layer.
    pdfs.markdownByContent.set('ocr-pdf', 'Recognized text from the scan');

    documentTypes = new InMemoryCategoryRepository();
    documentTypes.add('invoice', 'Bills and payment requests.');
    documentTypes.add('contract');
    analyst = new FakeAnalyst();
    people = new InMemoryPersonRepository();
    subjectKinds = new InMemorySubjectKindRepository();
    subjects = new InMemorySubjectRepository(subjectKinds);
    chunks = new InMemoryDocumentChunkRepository();
    embeddings = new FakeEmbeddingProvider();
    calls = new FakeCallContext();

    libraries.add(libraryFixture());

    transcriber = new FakeTranscriber();
    clock = new FixedClock();
    settings = {
      previewMaxDim: PREVIEW_MAX_DIM,
      thumbMaxDim: THUMB_MAX_DIM,
      ocrLanguages: ['rus', 'eng'],
      pdfTextMinCharsPerPage: MIN_CHARS_PER_PAGE,
      correctImagePages: true,
      chunkTargetChars: 200,
      chunkOverlapChars: 40,
      analystExcerptChars: 0,
      // Off for the suite: what the analyst is shown has its own tests, and every other test here
      // counts renders and resizes that step 4 would otherwise add to.
      analystMaxPageImages: 0,
      analystPageImageMaxDim: 1200,
      analystAutoMaxPages: 0,
      transcriberMaxPages: 0,
      transcriberPageImageMaxDim: 1600,
    };

    const queueSettings = queueSettingsFixture(4, queueStore);
    handler = new HandleDocumentProcess(
      documents,
      events,
      new BuildCanonical(
        fileRepo,
        fileRefs,
        libraries,
        reader,
        storage,
        images,
        pdfs,
        queueSettingsFixture(),
        settings,
      ),
      storage,
      pdfs,
      parser,
      images,
      documentTypes,
      analyst,
      transcriber,
      people,
      subjects,
      subjectKinds,
      chunks,
      embeddings,
      new ImmediateUnitOfWork(),
      calls,
      new AnalysisSettings(new InMemorySettingsRepository()),
      queueSettings,
      settings,
      clock,
    );
  });

  // Holding a step for the run about to happen (docs/05 §5.4d). Written straight into the settings
  // store the handler reads, because that is where a pause lives — one row, read per job.
  async function pauseSteps(...steps: DocumentStep[]): Promise<void> {
    await queueStore.write(QUEUE_SETTINGS_KEY, { pausedSteps: steps });
  }

  // A document and the files it is made of: a library file gets a ref pointing at the stub volume,
  // a managed one gets its bytes in the bucket.
  async function givenDocument(
    pages: PageSpec[] = [{}],
    overrides: Partial<Document> = {},
  ): Promise<Document> {
    const document = documents.add(documentFixture(overrides));
    for (const [index, page] of pages.entries()) {
      const file = fileRepo.add(
        { id: `file-${index + 1}`, name: `page-${index + 1}.pdf`, ...page.file },
        document.id,
      );
      // A crop and a turn are written on the entry this document holds, never on the file.
      if (page.crop !== undefined || page.turn !== undefined) {
        const held = await fileRepo.listPagesForDocument(document.id);
        await fileRepo.replacePages(
          document.id,
          held.map((entry) =>
            entry.fileId === file.id
              ? {
                  ...entry,
                  ...(page.crop === undefined ? {} : { crop: page.crop, cropSource: 'MANUAL' }),
                  ...(page.turn === undefined ? {} : { turn: page.turn }),
                }
              : entry,
          ),
        );
      }
      const bytes = page.bytes ?? `bytes-${index + 1}`;
      if (file.origin === 'MANAGED') {
        await storage.put(originalKeyOf(file), Buffer.from(bytes), file.mimeType);
      } else {
        const path = `invoices/${file.id}-${file.name}`;
        reader.put(path, bytes);
        fileRefs.add({
          id: `ref-${file.id}`,
          libraryId: LIBRARY_ID,
          fileId: file.id,
          path: RelativePath.parse(path),
        });
      }
    }
    return document;
  }

  const run = (documentId = DOCUMENT_ID): Promise<void> => handler.handle({ documentId });

  const stateOf = (id = DOCUMENT_ID): Document => {
    const document = documents.documents.get(id);
    if (document === undefined) throw new Error(`No document ${id}`);
    return document;
  };

  const canonicalOf = (id = DOCUMENT_ID): string =>
    storage.get(artifactKeys.canonicalPdf(id)).body.toString();

  const methodsCalled = (): string[] => pdfs.calls.map((call) => call.method);

  describe('the typed fields (docs/05 §5.5 step 5)', () => {
    it('fills the schema of the type the analysis just chose, validated per field', async () => {
      documentTypes.add('receipt');
      analyst.slug = 'receipt';
      analyst.fieldValues = {
        vendor: '  Voli ',
        purchasedAt: '2026-13-45',
        total: { amount: '12,40', currency: 'eur' },
        invented: 'never asked for',
      };
      await givenDocument();

      await run();

      const document = stateOf();
      expect(document.steps.fields).toBe('DONE');
      // A bad date is dropped and the good vendor beside it is kept (docs/03 §3.3.10a).
      expect(document.extracted).toEqual({
        schema: { slug: 'receipt', version: 2 },
        values: { vendor: 'Voli', total: { amount: 12.4, currency: 'EUR' } },
        sources: { vendor: 'AUTO', total: 'AUTO' },
      });
      // The model's whole reading is recorded either way — the "read as X" line reads it.
      expect(document.auto.fields).toEqual({
        vendor: 'Voli',
        total: { amount: 12.4, currency: 'EUR' },
      });
      expect(analyst.fieldCalls).toHaveLength(1);
      expect(analyst.fieldCalls[0]?.schemaSlug).toBe('receipt');
      expect(analyst.fieldCalls[0]?.excerpt).toContain(TEXT_LAYER);
    });

    it('skips NO_SCHEMA where the type carries none, and where there is no type at all', async () => {
      analyst.slug = 'contract';
      await givenDocument();

      await run();

      const document = stateOf();
      expect(document.steps.fields).toBe('SKIPPED');
      expect(document.skipReasons.fields).toBe('NO_SCHEMA');
      expect(analyst.fieldCalls).toHaveLength(0);
    });

    it('skips NOT_CONFIGURED with a schema but no provider', async () => {
      const receipt = documentTypes.add('receipt');
      analyst.configured = false;
      await givenDocument([{}], { typeId: receipt.id, typeSource: 'MANUAL' });

      await run();

      const document = stateOf();
      expect(document.steps.fields).toBe('SKIPPED');
      expect(document.skipReasons.fields).toBe('NOT_CONFIGURED');
    });

    it('keeps a MANUAL value whatever the model reads — fill-blanks per field', async () => {
      const receipt = documentTypes.add('receipt');
      analyst.fieldValues = { vendor: 'Model corp', purchasedAt: '2026-05-12' };
      await givenDocument([{}], {
        typeId: receipt.id,
        typeSource: 'MANUAL',
        extracted: {
          schema: { slug: 'receipt', version: 1 },
          values: { vendor: 'Voli' },
          sources: { vendor: 'MANUAL' },
        },
      });

      await run();

      const document = stateOf();
      expect(document.extracted).toEqual({
        schema: { slug: 'receipt', version: 2 },
        values: { vendor: 'Voli', purchasedAt: '2026-05-12' },
        sources: { vendor: 'MANUAL', purchasedAt: 'AUTO' },
      });
      // What the model said is still on record, so the correction is never a dead end.
      expect(document.auto.fields).toEqual({ vendor: 'Model corp', purchasedAt: '2026-05-12' });
    });

    it('replaces a reading that speaks another schema wholesale, manual corrections included', async () => {
      const receipt = documentTypes.add('receipt');
      analyst.fieldValues = { vendor: 'Voli' };
      await givenDocument([{}], {
        typeId: receipt.id,
        typeSource: 'MANUAL',
        // What a passport reading looks like the moment somebody re-types the document (docs/05
        // §5.5 step 5): corrections to fields the document no longer has.
        extracted: {
          schema: { slug: 'passport', version: 1 },
          values: { holder: 'Ana Petrović' },
          sources: { holder: 'MANUAL' },
        },
      });

      await run();

      expect(stateOf().extracted).toEqual({
        schema: { slug: 'receipt', version: 2 },
        values: { vendor: 'Voli' },
        sources: { vendor: 'AUTO' },
      });
    });

    it('is gated by step 3 like the analysis: a failed extraction fails it without owning the failure', async () => {
      const receipt = documentTypes.add('receipt');
      await givenDocument([{}], {
        typeId: receipt.id,
        typeSource: 'MANUAL',
        steps: {
          canonical: 'DONE',
          preview: 'DONE',
          markdown: 'FAILED',
          analysis: 'FAILED',
          fields: 'PENDING',
          vectorization: 'FAILED',
        },
        processingError: 'parser exploded',
        failedStep: 'markdown',
      });

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['fields'] });

      const document = stateOf();
      expect(document.steps.fields).toBe('FAILED');
      // The reason stays the one step 3 hit (docs/05 §5.5).
      expect(document.failedStep).toBe('markdown');
      expect(document.processingError).toBe('parser exploded');
      expect(analyst.fieldCalls).toHaveLength(0);
    });

    it('respects the page limit unasked and lifts it for analyseInFull', async () => {
      const receipt = documentTypes.add('receipt');
      settings.analystAutoMaxPages = 2;
      analyst.fieldValues = { vendor: 'Voli' };
      await givenDocument([{}], {
        typeId: receipt.id,
        typeSource: 'MANUAL',
        pageCount: 5,
        steps: {
          canonical: 'DONE',
          preview: 'DONE',
          markdown: 'DONE',
          analysis: 'DONE',
          fields: 'PENDING',
          vectorization: 'DONE',
        },
      });

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['fields'] });
      expect(stateOf().steps.fields).toBe('SKIPPED');
      expect(stateOf().skipReasons.fields).toBe('TOO_MANY_PAGES');

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['fields'], analyseInFull: true });
      expect(stateOf().steps.fields).toBe('DONE');
      expect(stateOf().extracted?.values).toEqual({ vendor: 'Voli' });
    });

    it('records a failed call against the step itself', async () => {
      const receipt = documentTypes.add('receipt');
      analyst.failing = true;
      await givenDocument([{}], { typeId: receipt.id, typeSource: 'MANUAL' });

      await run();

      const document = stateOf();
      // Both calls go to the same provider, so both steps fail; the pointer names the last one to
      // hit it, and the step's own status is what says the fields were never read.
      expect(document.steps.fields).toBe('FAILED');
      expect(document.failedStep).toBe('fields');
      expect(document.processingError).toContain('Analyst request failed');
    });
  });

  describe('the canonical PDF (docs/05 §5.5 step 1)', () => {
    it('takes a PDF as it is: one part, no merge, straight into the bucket', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.pageCount = 12;
      pdfs.defaultMarkdown = `${TEXT_LAYER}\n\n`.repeat(12);

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('DONE');
      // 🔒 Every document has one, whatever it was made of (ADR-021).
      expect(canonicalOf()).toBe('a-pdf');
      expect(document.pageCount).toBe(12);
      // A single-part document skips the merge and keeps its part (docs/05 §5.5 step 1).
      expect(methodsCalled()).not.toContain('mergePdfs');
    });

    it('lays an image on a page, and applies the crop it carries first', async () => {
      await givenDocument([
        {
          file: {
            mimeType: 'image/jpeg',
            ext: 'jpg',
            name: 'passport.jpg',
          },
          crop: {
            points: [
              [0.1, 0.2],
              [0.9, 0.2],
              [0.9, 0.8],
              [0.1, 0.8],
            ],
          },
          bytes: 'photo',
        },
      ]);

      await run();

      // The perspective transform runs over the original and its result becomes the page; the file
      // itself is never rewritten (docs/03 §3.3.17).
      expect(images.crops).toEqual([
        {
          input: 'photo',
          crop: {
            points: [
              [0.1, 0.2],
              [0.9, 0.2],
              [0.9, 0.8],
              [0.1, 0.8],
            ],
          },
        },
      ]);
      expect(pdfs.calls).toContainEqual({ method: 'imagesToPdf', fileName: 'page-0000.jpg' });
      // Wrapped in the format the page ends up at: a photograph of a sheet becomes A4, and it
      // becomes it *after* the crop and the recognition (docs/05 §5.5 step 1).
      expect(canonicalOf()).toBe('scaled-A4-PORTRAIT(image-pdf(cropped(0.1,0.2):photo))');
    });

    it('lays an uncropped image on a page exactly as it arrived', async () => {
      await givenDocument([
        { file: { mimeType: 'image/png', ext: 'png', name: 'scan.png' }, bytes: 'photo' },
      ]);

      await run();

      expect(images.crops).toEqual([]);
      expect(pdfs.calls).toContainEqual({ method: 'imagesToPdf', fileName: 'page-0000.png' });
      expect(canonicalOf()).toBe('scaled-A4-PORTRAIT(image-pdf(photo))');
    });

    it('converts an office document, and plain text through the same door', async () => {
      await givenDocument([
        {
          file: {
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ext: 'docx',
            name: 'Q1 report.docx',
          },
          bytes: 'docx-bytes',
        },
        { file: { mimeType: 'text/plain', ext: 'txt', name: 'notes.txt' }, bytes: 'plain text' },
      ]);

      await run();

      // The converter picks its input filter from the extension, so each file keeps its own name.
      expect(pdfs.calls.filter((call) => call.method === 'toPdf')).toEqual([
        { method: 'toPdf', fileName: 'Q1 report.docx' },
        { method: 'toPdf', fileName: 'notes.txt' },
      ]);
      expect(stateOf().steps.canonical).toBe('DONE');
    });

    it('merges the parts in position order', async () => {
      await givenDocument([
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'first' },
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'second' },
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'third' },
      ]);

      await run();

      // 🔒 Page order is position order (docs/05 §5.5 step 1): a reordered merge is a wrong document.
      expect(canonicalOf()).toBe('merged(first,second,third)');
    });

    it('keeps the order even when the files are prepared several at a time', async () => {
      // The unit concurrency of docs/05 §5.4 is about throughput, never about sequence.
      handler = withUnitConcurrency(3);
      await givenDocument([
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'one' },
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'two' },
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'three' },
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'four' },
      ]);

      await run();

      expect(canonicalOf()).toBe('merged(one,two,three,four)');
    });

    it('reads a managed file out of the bucket rather than off a volume', async () => {
      await givenDocument([
        {
          file: {
            origin: 'MANAGED',
            storageKey: 'files/file-1/original.pdf',
            mimeType: 'application/pdf',
            ext: 'pdf',
          },
          bytes: 'uploaded',
        },
      ]);

      await run();

      expect(canonicalOf()).toBe('uploaded');
      expect(reader.opened).toEqual([]);
    });

    it('leaves out a file nothing can render, and says the step is incomplete', async () => {
      await givenDocument([
        { file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'readable' },
        { file: { mimeType: 'application/x-executable', ext: 'bin' }, bytes: 'binary' },
      ]);

      await run();

      const document = stateOf();
      // The document is built out of what could be built, and the reason it is short of a page is
      // recorded rather than turned into a failure (docs/05 §5.5 step 1).
      expect(document.steps.canonical).toBe('DONE');
      expect(document.skipReasons.canonical).toBe('UNSUPPORTED_FORMAT');
      expect(canonicalOf()).toBe('readable');
    });

    it('builds nothing for a document nothing can render, and fails no step over it', async () => {
      await givenDocument([
        { file: { mimeType: 'application/x-executable', ext: 'bin' }, bytes: 'binary' },
      ]);

      await run();

      const document = stateOf();
      // 🔒 No step is left PENDING — the document would read as "still processing" for the rest of
      // its life (docs/03 §3.3.10) — and the two steps that read the extraction inherit the reason
      // it recorded rather than inventing one of their own (docs/05 §5.5).
      expect(document.steps).toMatchObject({
        canonical: 'SKIPPED',
        preview: 'SKIPPED',
        markdown: 'SKIPPED',
        analysis: 'SKIPPED',
        vectorization: 'SKIPPED',
      });
      expect(document.skipReasons).toMatchObject({
        canonical: 'UNSUPPORTED_FORMAT',
        preview: 'UNSUPPORTED_FORMAT',
        markdown: 'UNSUPPORTED_FORMAT',
        analysis: 'UNSUPPORTED_FORMAT',
        vectorization: 'UNSUPPORTED_FORMAT',
      });
      expect(document.processingError).toBeNull();
      expect(storage.keys()).toEqual([]);
    });

    it('does not crash over a document with no files at all', async () => {
      await givenDocument([]);

      await run();

      expect(stateOf().steps.canonical).toBe('SKIPPED');
      expect(stateOf().pageCount).toBeNull();
      expect(methodsCalled()).toEqual([]);
    });

    it('OCRs a merged PDF whose text layer is too thin, and stores the searchable one', async () => {
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }]);
      // A scan often carries a few stray characters — page numbers, a watermark — which is exactly
      // what PDF_TEXT_MIN_CHARS_PER_PAGE is there to see through (docs/05 §5.9).
      pdfs.markdownByContent.set('image-pdf(photo)', '1\n\n2');

      await run();

      // 🔒 The searchable PDF becomes the canonical; until this release the OCR pass was run and
      // thrown away (docs/05 §5.5 step 1).
      // 🔒 The order the archive depends on: recognised first, given its format second. The other
      // way round the page carries white margins into the recognizer and comes back blank.
      expect(canonicalOf()).toBe('scaled-A4-PORTRAIT(ocr-pdf)');
      expect(stateOf().ocrUsed).toBe(true);
      expect(methodsCalled()).toContain('ocrPdf');
    });

    it('leaves a PDF that carries its own text alone', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      expect(stateOf().ocrUsed).toBe(false);
      expect(methodsCalled()).not.toContain('ocrPdf');
    });

    it("OCRs in the document's own languages once they are known", async () => {
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }], {
        languages: ['ru', 'sr-Latn'],
      });
      pdfs.markdownByContent.set('image-pdf(photo)', '');

      await run();

      // BCP-47 in the row, tesseract codes on the wire — `srp_latn`, not `srp`, or every diacritic
      // is lost (docs/03 §3.3.10).
      expect(pdfs.ocrLanguages[0]).toEqual(['rus', 'srp_latn']);
    });

    it('stamps the title and the date the document carries', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        title: 'Lease agreement',
        documentDate: '2019-07-14',
      });

      await run();

      expect(pdfs.stamped).toEqual([
        { title: 'Lease agreement', date: new Date('2019-07-14T00:00:00.000Z') },
      ]);
    });

    it('keeps the canonical when the metadata pass fails, because the pages are the document', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.failOn('stampMetadata');

      await run();

      // Best-effort by the spec: a PDF with the wrong /Title is still the document (docs/05 §5.5).
      expect(stateOf().steps.canonical).toBe('DONE');
      expect(canonicalOf()).toBe('a-pdf');
      expect(stateOf().processingError).toBeNull();
    });

    it('fails the step when a file it needs is no longer on any volume', async () => {
      const document = documents.add(documentFixture());
      fileRepo.add({ id: 'file-lost', mimeType: 'application/pdf', ext: 'pdf' }, document.id);

      await run();

      const state = stateOf();
      expect(state.steps.canonical).toBe('FAILED');
      expect(state.failedStep).toBe('canonical');
      expect(state.processingError).toContain('not on any volume');
      // Nothing half-written: the old canonical, if there was one, is still what serves readers.
      expect(storage.keys()).toEqual([]);
    });

    it('fails the step when the converter refuses a file', async () => {
      await givenDocument([
        {
          file: { mimeType: 'application/msword', ext: 'doc', name: 'Notes.doc' },
          bytes: 'doc-bytes',
        },
      ]);
      pdfs.failOn('toPdf');

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('FAILED');
      expect(document.processingError).toContain('toPdf failed');
      expect(storage.keys()).toEqual([]);
    });
  });

  describe('the preview (docs/05 §5.5 step 2)', () => {
    it('renders the first page of the canonical, at both configured sizes', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      expect(images.resizes).toEqual([
        { maxDim: PREVIEW_MAX_DIM, quality: 80, input: 'rendered-page' },
        { maxDim: THUMB_MAX_DIM, quality: 75, input: 'rendered-page' },
      ]);
      expect(storage.get(artifactKeys.preview(DOCUMENT_ID)).contentType).toBe('image/jpeg');
      expect(storage.get(artifactKeys.thumbnail(DOCUMENT_ID)).body.toString()).toBe(
        `jpeg:${THUMB_MAX_DIM}:rendered-page`,
      );
    });

    it('previews an image document the same way as any other, because it is a PDF by now', async () => {
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }]);

      await run();

      expect(stateOf().steps.preview).toBe('DONE');
      // One rule for every document (docs/05 §5.5 step 2): the render reads the canonical.
      expect(images.resizes.map((resize) => resize.input)).toEqual([
        'rendered-page',
        'rendered-page',
      ]);
    });

    it('fails when the canonical it needed was never produced, keeping step 1 as the cause', async () => {
      await givenDocument([
        { file: { mimeType: 'application/msword', ext: 'doc' }, bytes: 'doc-bytes' },
      ]);
      pdfs.failOn('toPdf');

      await run();

      const document = stateOf();
      expect(document.steps.preview).toBe('FAILED');
      // The reported cause stays the conversion failure rather than being overwritten by its
      // consequence — "no canonical PDF" tells an admin nothing they can act on.
      expect(document.failedStep).toBe('canonical');
      expect(document.processingError).toContain('toPdf failed');
    });

    it('keeps a rendering failure out of the canonical', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.failOn('pdfPageJpg');

      await run();

      const document = stateOf();
      // 🔒 Step isolation (docs/05 §5.5): the canonical PDF was produced and stays DONE.
      expect(document.steps.canonical).toBe('DONE');
      expect(document.steps.preview).toBe('FAILED');
      expect(storage.keys()).toEqual([artifactKeys.canonicalPdf(DOCUMENT_ID)]);
    });

    it('reports a page the resizer cannot read as a preview failure', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      images.failing = true;

      await run();

      expect(stateOf().steps.preview).toBe('FAILED');
      expect(stateOf().processingError).toContain('unsupported image format');
    });
  });

  describe('markdown (docs/05 §5.5 step 3)', () => {
    it('reads the canonical, and nothing else', async () => {
      await givenDocument([
        { file: { mimeType: 'application/rtf', ext: 'rtf' }, bytes: 'rtf-bytes' },
      ]);
      pdfs.markdownByContent.set(
        'converted-pdf',
        'Converted body text that is long enough to trust',
      );

      await run();

      expect(stateOf().markdown).toBe('Converted body text that is long enough to trust');
      // 🔒 The original is never read again: every step after the first reads the canonical
      // (ADR-021).
      expect(pdfs.markdownReads.every((read) => read !== 'rtf-bytes')).toBe(true);
    });

    it('recognises a canonical that still has no text after step 1 tried', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.defaultMarkdown = ['1', '2', '3'].join('\n\n');

      await run();

      const document = stateOf();
      expect(document.markdown).toBe('Recognized text from the scan');
      expect(document.ocrUsed).toBe(true);
    });

    it('measures the text layer per page, not in total', async () => {
      // 200 characters spread over 20 pages is 10 per page: a scan, however long.
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.defaultMarkdown = 'ten chars.'.repeat(20);
      pdfs.pageCount = 20;

      await run();

      expect(stateOf().ocrUsed).toBe(true);
    });

    it('reads a recognised document with the vision model, and keeps that instead', async () => {
      transcriber.configured = true;
      transcriber.markdown = '| Chlamydia | не обнаружено |\n| Ureaplasma | не обнаружено |';
      transcriber.usage = { promptTokens: 1500, completionTokens: 300 };
      settings.transcriberMaxPages = 20;
      pdfs.pageCount = 1;
      // The page carries almost no text of its own, so step 1 recognises it — which is the case
      // this whole path exists for.
      pdfs.markdownByContent.set('image-pdf(photo)', '1\n\n2');
      pdfs.markdownByContent.set('scaled-A4-PORTRAIT(ocr-pdf)', 'Recognized text from the scan');
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }]);

      await run();

      // A photograph is exactly where the cheap path has a floor no tuning lifts: on one real lab
      // report, 665 legible characters became 415, and the quarter that vanished was the results
      // table (docs/05 §5.5 step 3).
      expect(transcriber.calls).toHaveLength(1);
      expect(stateOf().markdown).toContain('Chlamydia');
      const finished = events.events.filter((event) => event.type === 'STEP_FINISHED');
      const markdownStep = finished.find((event) => event.payload?.step === 'markdown');
      expect(markdownStep?.payload?.promptTokens).toBe(1500);
    });

    it('leaves a document that carried its own text alone', async () => {
      transcriber.configured = true;
      settings.transcriberMaxPages = 20;
      // Long enough that step 1 never OCRs it: reading a text layer is free and perfect, and no
      // model improves on perfect.
      pdfs.defaultMarkdown = 'A'.repeat(MIN_CHARS_PER_PAGE * 4);
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      expect(transcriber.calls).toHaveLength(0);
    });

    it('will not let the model empty a document it could not read', async () => {
      transcriber.configured = true;
      // A refusal, a truncated answer, a blank — all of them come back as less than there was.
      transcriber.markdown = 'I cannot read this image.';
      settings.transcriberMaxPages = 20;
      pdfs.pageCount = 1;
      // The page carries almost no text of its own, so step 1 recognises it — which is the case
      // this whole path exists for.
      pdfs.markdownByContent.set('image-pdf(photo)', '1\n\n2');
      pdfs.markdownByContent.set('scaled-A4-PORTRAIT(ocr-pdf)', 'Recognized text from the scan');
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }]);

      await run();

      // 🔒 What OCR already had stands: "it came back with less" is the one signal available before
      // anybody reads it (docs/05 §5.5 step 3).
      expect(stateOf().markdown).toBe('Recognized text from the scan');
    });

    it('keeps the recognised text when the transcriber is unreachable', async () => {
      transcriber.configured = true;
      transcriber.failing = true;
      settings.transcriberMaxPages = 20;
      pdfs.pageCount = 1;
      // The page carries almost no text of its own, so step 1 recognises it — which is the case
      // this whole path exists for.
      pdfs.markdownByContent.set('image-pdf(photo)', '1\n\n2');
      pdfs.markdownByContent.set('scaled-A4-PORTRAIT(ocr-pdf)', 'Recognized text from the scan');
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }]);

      await run();

      expect(stateOf().steps.markdown).toBe('DONE');
      expect(stateOf().markdown).toBe('Recognized text from the scan');
    });

    it('stores nothing rather than an empty string when there is no text at all', async () => {
      await givenDocument([{ file: { mimeType: 'image/png', ext: 'png' }, bytes: 'photo' }]);
      pdfs.markdownByContent.set('image-pdf(photo)', '');
      pdfs.markdownByContent.set('ocr-pdf', ['', '   '].join('\n\n'));
      // Step 3 reads the finished canonical, which is the formatted one.
      pdfs.markdownByContent.set('scaled-A4-PORTRAIT(ocr-pdf)', ['', '   '].join('\n\n'));

      await run();

      const document = stateOf();
      // The step ran and answered "there is no text here" — that is DONE, not FAILED.
      expect(document.steps.markdown).toBe('DONE');
      expect(document.markdown).toBeNull();
    });

    it('keeps a markdown failure from touching the canonical or the preview', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('DONE');
      expect(document.steps.preview).toBe('DONE');
      expect(document.steps.markdown).toBe('FAILED');
      expect(document.failedStep).toBe('markdown');
      expect(document.processingError).toContain('toMarkdown failed');
    });

    it('cannot read a document whose canonical was never built', async () => {
      await givenDocument([
        { file: { mimeType: 'application/msword', ext: 'doc' }, bytes: 'doc-bytes' },
      ]);
      pdfs.failOn('toPdf');

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('FAILED');
      // Still the conversion error, not a second report of its consequence.
      expect(document.failedStep).toBe('canonical');
    });

    it('parses through Docling when it is configured, and reads its languages back', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.markdown =
        '## Договор оказания услуг\n\nНастоящий договор заключён между сторонами третьего ' +
        'августа две тысячи двадцать шестого года и вступает в силу с момента подписания. ' +
        'Исполнитель обязуется обеспечить сохранность документов и ежемесячную отчётность.';

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('DONE');
      // The structure the parser recovered survives into the column — headings and all.
      expect(document.markdown).toContain('## Договор');
      // 🔒 And the document now knows what it is written in, which is what a later OCR pass is given.
      expect(document.languages).toEqual(['ru']);
      // A PDF with its own text is read, never recognised: no OCR languages were asked for.
      expect(parser.calls).toEqual([{ ocrLanguages: [], pageCount: 1 }]);
    });

    it('hands the parser the page count of the canonical it just built', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.markdown = 'A'.repeat(MIN_CHARS_PER_PAGE * 40);
      pdfs.pageCount = 40;

      await run();

      // What the parser windows a long document by (docs/05 §5.5 step 3).
      expect(parser.calls[0]?.pageCount).toBe(40);
    });

    it("gives the parser the document's own languages when it has to recognise", async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        languages: ['ru', 'sr-Latn'],
      });
      parser.configured = true;
      parser.markdown = 'Договор / Ugovor';

      await run();

      expect(parser.calls).toEqual([
        { ocrLanguages: [], pageCount: 1 },
        { ocrLanguages: ['rus', 'srp_latn'], pageCount: 1 },
      ]);
    });

    it('falls back to the instance languages when the document has none yet', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.markdown = 'x';

      await run();

      // The instance default from ProcessingSettings, exactly as configured.
      expect(parser.calls).toEqual([
        { ocrLanguages: [], pageCount: 1 },
        { ocrLanguages: ['rus', 'eng'], pageCount: 1 },
      ]);
    });
  });

  it('says a step is running before it runs, so a slow one is not mistaken for a stuck one', async () => {
    await givenDocument([
      { file: { mimeType: 'text/plain', ext: 'txt' }, bytes: 'Amount due: 1200.' },
    ]);

    await run();

    // The order matters, not the count: every step is announced before it is settled (docs/03
    // §3.3.10). Parsing with picture captions takes minutes — for those minutes PENDING would read
    // as "nothing is happening".
    for (const step of ['canonical', 'preview', 'markdown', 'analysis', 'vectorization'] as const) {
      const statuses = documents.updates
        .map((entry) => entry.update.steps?.[step])
        .filter((status) => status !== undefined);
      // A re-run resets the earlier steps to PENDING first, so RUNNING is not necessarily the
      // first thing written — but it always comes before the outcome, and never after it.
      expect(statuses).toContain('RUNNING');
      expect(statuses.indexOf('RUNNING')).toBe(statuses.length - 2);
      expect(statuses.at(-1)).not.toBe('RUNNING');
    }
  });

  it('writes the history of the run: every step started, every step settled', async () => {
    await givenDocument([
      { file: { mimeType: 'application/x-executable', ext: 'bin' }, bytes: 'binary' },
    ]);

    await run();

    const markdown = events.events.filter((event) => event.payload?.step === 'markdown');
    expect(markdown.map((event) => event.type)).toEqual(['STEP_STARTED', 'STEP_FINISHED']);

    // 🔒 A skip carries its reason into the log, or the log says "SKIPPED" as uselessly as the
    // panel used to (docs/03 §3.3.10).
    const canonical = events.events.find(
      (event) => event.payload?.step === 'canonical' && event.type === 'STEP_FINISHED',
    );
    expect(canonical?.payload).toMatchObject({
      status: 'SKIPPED',
      reason: 'UNSUPPORTED_FORMAT',
    });
  });

  it('records a failure with the message, not just the status', async () => {
    await givenDocument([{ file: { mimeType: 'text/plain', ext: 'txt' }, bytes: 'text' }]);
    embeddings.failing = true;

    await run();

    const failed = events.events.find((event) => event.payload?.status === 'FAILED');
    expect(failed?.payload?.step).toBe('vectorization');
    expect(failed?.payload?.error).toBeDefined();
  });

  it('says which service did a step, and ties both entries to one request id', async () => {
    await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
    parser.configured = true;
    parser.markdown = TEXT_LAYER;

    await run();

    const markdown = events.events.filter((event) => event.payload?.step === 'markdown');
    expect(markdown.map((event) => event.type)).toEqual(['STEP_STARTED', 'STEP_FINISHED']);
    // Whichever parser this instance actually runs (docs/05 §5.5 step 3).
    expect(markdown[0]?.payload?.service).toBe('docling');
    expect(markdown[0]?.payload?.endpoint).toBe('http://docling.test');
    // 🔒 One id for the pair: a started entry nobody can match to its outcome is no thread at all
    // (docs/03 §3.3.18).
    expect(markdown[0]?.payload?.requestId).toBe(markdown[1]?.payload?.requestId);
    expect(calls.ids).toContain(markdown[0]?.payload?.requestId);

    const analysis = events.events.filter((event) => event.payload?.step === 'analysis');
    expect(analysis[0]?.payload?.service).toBe('classifier');
  });

  it('names Stirling when there is no Docling, and nothing where there is no service at all', async () => {
    await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
    parser.configured = false;
    embeddings.configured = false;

    await run();

    const markdown = events.events.filter((event) => event.payload?.step === 'markdown');
    expect(markdown[0]?.payload?.service).toBe('stirling');
    expect(markdown[0]?.payload?.endpoint).toBe('http://stirling.test');
    // A step this instance does not send anywhere names nobody: there is no other log to read.
    const vectors = events.events.filter((event) => event.payload?.step === 'vectorization');
    expect(vectors[0]?.payload?.service).toBeUndefined();
    expect(vectors[0]?.payload?.endpoint).toBeUndefined();
  });

  describe('analysis (docs/05 §5.5 step 4)', () => {
    it('assigns the documentType the analyst chose, marked as automatic', async () => {
      await givenDocument(
        [{ file: { mimeType: 'text/plain', ext: 'txt' }, bytes: 'Amount due: 1200.' }],
        { title: 'March invoice' },
      );
      analyst.slug = 'invoice';

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('DONE');
      expect(document.typeId).toBe('documentType-1');
      expect(document.typeSource).toBe('AUTO');
    });

    it('offers the analyst the slugs and the descriptions an admin wrote', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        title: 'March invoice',
      });
      pdfs.defaultMarkdown = 'Amount due: 1200.';

      await run();

      const call = analyst.calls[0];
      expect(call?.documentTypes).toEqual([
        { slug: 'invoice', name: 'invoice', description: 'Bills and payment requests.' },
        { slug: 'contract', name: 'contract', description: null },
      ]);
      // Title first, then the extracted text — the title is there even when the text is not.
      expect(call?.excerpt).toBe('March invoice\n\nRecognized text from the scan');
    });

    it('shows the analyst the whole text, not the opening of it', async () => {
      // Four thousand characters used to be the cap, and the opening of a document is its
      // letterhead: enough to tell a bank from a landlord, nowhere near enough to tell one contract
      // from another (docs/05 §5.5 step 4).
      const long = `${'a'.repeat(4_000)}TAIL`;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.defaultMarkdown = long;

      await run();

      expect(analyst.calls[0]?.excerpt).toContain('TAIL');
    });

    it('obeys an instance that does want the text cut', async () => {
      settings.analystExcerptChars = 20;
      const long = `${'a'.repeat(4_000)}TAIL`;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.defaultMarkdown = long;

      await run();

      expect(analyst.calls[0]?.excerpt).toHaveLength(20);
    });

    it('shows it the pages as well, capped at what an instance allows', async () => {
      settings.analystMaxPageImages = 2;
      pdfs.pageCount = 5;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // A document is a picture before it is a string: this is what lets the model answer at all on
      // a scan whose recognition found nothing, and what it judges the text against.
      expect(analyst.calls[0]?.pages).toBe(2);
    });

    it('analyses on the text alone when the pages will not render', async () => {
      settings.analystMaxPageImages = 3;
      pdfs.pageCount = 3;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.failures.add('pdfPageJpg');

      await run();

      // A missing picture is not a reason to learn nothing — and the preview failing is its own
      // step's business, not step 4's (docs/05 §5.5).
      expect(analyst.calls).toHaveLength(1);
      expect(analyst.calls[0]?.pages).toBe(0);
      expect(stateOf().steps.analysis).toBe('DONE');
    });

    it('says a step is queued while a job exists, and pending only when none does', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      // What a migration leaves behind: the artifact is out of date and nothing is scheduled.
      await documents.updateProcessing(DOCUMENT_ID, { steps: { canonical: 'PENDING' } });
      expect(stateOf().steps.canonical).toBe('PENDING');

      await run();

      // 🔒 The run itself is a job, so while it clears the slate the steps read QUEUED — the word
      // that means "somebody is coming for this" (docs/03 §3.3.10).
      const started = events.events.filter((event) => event.type === 'STEP_STARTED');
      expect(started.length).toBeGreaterThan(0);
      expect(stateOf().steps.canonical).toBe('DONE');
    });

    it('writes down what the step cost and what it produced', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.answer = { ...analyst.answer, usage: { promptTokens: 900, completionTokens: 40 } };

      await run();

      const finished = events.events.filter((event) => event.type === 'STEP_FINISHED');
      const markdown = finished.find((event) => event.payload?.step === 'markdown');
      const analysis = finished.find((event) => event.payload?.step === 'analysis');
      // The journal already bracketed every step; what it never said was how long the bracket was,
      // and whether anything came out of it (docs/03 §3.3.18).
      expect(markdown?.payload?.durationMs).toBeTypeOf('number');
      // The text that was actually stored, whichever branch produced it — read back off the
      // document rather than assumed, because the count is only useful if it is that one.
      expect(markdown?.payload?.chars).toBe(stateOf().markdown?.length);
      expect(analysis?.payload?.promptTokens).toBe(900);
      expect(analysis?.payload?.completionTokens).toBe(40);
      // A step in progress has spent nothing yet.
      const started = events.events.find((event) => event.type === 'STEP_STARTED');
      expect(started?.payload?.durationMs).toBeUndefined();
    });

    it('does not analyse a book unasked, and says why', async () => {
      settings.analystAutoMaxPages = 10;
      pdfs.pageCount = 40;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // 🔒 Not a shortened analysis: a verdict read off the first ten pages of a forty-page contract
      // is worse than no verdict, because it looks like one (docs/05 §5.5 step 4).
      const state = stateOf();
      expect(state.steps.analysis).toBe('SKIPPED');
      expect(state.skipReasons.analysis).toBe('TOO_MANY_PAGES');
      expect(analyst.calls).toHaveLength(0);
    });

    it('analyses it however long it is when a person asks', async () => {
      settings.analystAutoMaxPages = 10;
      pdfs.pageCount = 40;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await handler.handle({ documentId: DOCUMENT_ID, analyseInFull: true });

      expect(stateOf().steps.analysis).toBe('DONE');
      expect(analyst.calls).toHaveLength(1);
    });

    it('analyses a short document without being asked', async () => {
      settings.analystAutoMaxPages = 10;
      pdfs.pageCount = 3;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      expect(stateOf().steps.analysis).toBe('DONE');
    });

    it('stops calling a document too long once it has been analysed in full', async () => {
      settings.analystAutoMaxPages = 10;
      pdfs.pageCount = 40;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await run();
      expect(stateOf().skipReasons.analysis).toBe('TOO_MANY_PAGES');

      await handler.handle({ documentId: DOCUMENT_ID, analyseInFull: true });

      // 🔒 A reason left behind outlives the thing it explained: the document would stay marked as
      // too long to analyse and go on offering the button that asks for it again (docs/03 §3.3.10).
      expect(stateOf().steps.analysis).toBe('DONE');
      expect(stateOf().skipReasons.analysis).toBeUndefined();
    });

    it('keeps the verdict on how well the text was extracted', async () => {
      settings.analystMaxPageImages = 1;
      pdfs.pageCount = 1;
      analyst.answer = { ...analyst.answer, textQuality: 'NONE' };
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // The signal nobody had: recognition that returned nothing reported success, and the only way
      // to notice was to open the document (docs/05 §5.5 step 4).
      expect(stateOf().auto.textQuality).toBe('NONE');
    });

    it('keeps the marks each step gave its own work, on the document and in the journal', async () => {
      documentTypes.add('receipt');
      analyst.slug = 'receipt';
      analyst.answer = {
        ...analyst.answer,
        textQuality: 'PARTIAL',
        legibility: 20,
        extraction: 95,
      };
      analyst.fieldValues = { vendor: 'Voli' };
      analyst.fieldConfidence = 78;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // Both steps write into one key, and neither erases the other's half (docs/03 §3.3.10).
      expect(stateOf().auto.quality).toEqual({ legibility: 20, extraction: 95, confidence: 78 });
      // The ternary survives beside the number it refines: the Text tab still acts on the word.
      expect(stateOf().auto.textQuality).toBe('PARTIAL');

      // And on the entry that settles each step, beside what that step cost — so the journal keeps
      // what *that* run thought of itself (docs/03 §3.3.18).
      const finished = events.events.filter((event) => event.type === 'STEP_FINISHED');
      const analysis = finished.find((event) => event.payload?.step === 'analysis');
      const fields = finished.find((event) => event.payload?.step === 'fields');
      expect(analysis?.payload).toMatchObject({ legibility: 20, extraction: 95 });
      expect(analysis?.payload?.confidence).toBeUndefined();
      expect(fields?.payload).toMatchObject({ confidence: 78 });
      expect(fields?.payload?.durationMs).toBeTypeOf('number');
    });

    it('writes no mark at all where the model answered none, because a missing mark is not a zero', async () => {
      documentTypes.add('receipt');
      analyst.slug = 'receipt';
      analyst.fieldValues = { vendor: 'Voli' };
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // 🔒 An older provider, or a call shown no pages, is a silence — and a silence recorded as a
      // nought would be the worst reading this product ever made of itself (docs/03 §3.3.18).
      expect(stateOf().auto.quality).toEqual({});
      const finished = events.events.filter((event) => event.type === 'STEP_FINISHED');
      for (const step of ['analysis', 'fields']) {
        const payload = finished.find((event) => event.payload?.step === step)?.payload;
        expect(payload?.legibility).toBeUndefined();
        expect(payload?.extraction).toBeUndefined();
        expect(payload?.confidence).toBeUndefined();
      }
    });

    it('leaves the mark of the other step standing when only one of them runs again', async () => {
      documentTypes.add('receipt');
      analyst.slug = 'receipt';
      analyst.answer = { ...analyst.answer, legibility: 20, extraction: 95 };
      analyst.fieldValues = { vendor: 'Voli' };
      analyst.fieldConfidence = 78;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await run();

      // The analysis alone, answering differently this time.
      analyst.answer = { ...analyst.answer, legibility: 55, extraction: 60 };
      await handler.handle({ documentId: DOCUMENT_ID, steps: ['analysis'] });

      // `autoValues` merges a key at a time, and `quality` is the one key two steps write into: a
      // step that replaced it with its own half would take the other's away (docs/03 §3.3.10).
      expect(stateOf().auto.quality).toEqual({ legibility: 55, extraction: 60, confidence: 78 });
    });

    it('clamps a mark an implementation of the port answered outside the range', async () => {
      analyst.answer = { ...analyst.answer, legibility: 140, extraction: -3 };
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // The adapter clamps what a provider sends; this is the pipeline refusing to store a mark
      // out of range whatever hands it one, since an unreadable `autoValues` costs the document
      // everything else the pipeline read about it (docs/03 §3.3.10).
      expect(stateOf().auto.quality).toEqual({ legibility: 100, extraction: 0 });
    });

    it('records no documentType when the model answers with a slug nobody defined', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      // 🔒 A hallucinated documentType must not become a real one (docs/05 §5.5 step 4).
      analyst.slug = 'tax-return-2019';

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('DONE');
      expect(document.typeId).toBeNull();
      expect(document.typeSource).toBe('NONE');
    });

    it('analyses a document whose type a person chose, and ignores its answer on the type', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        typeId: 'documentType-2',
        typeSource: 'MANUAL',
      });
      analyst.answer = { ...analyst.answer, typeSlug: 'invoice', country: 'ME' };

      await run();

      const document = stateOf();
      // The step used to be skipped whole, which cost the document everything else it reads
      // (docs/05 §5.5 step 4): it runs now.
      expect(document.steps.analysis).toBe('DONE');
      expect(document.skipReasons.analysis).toBeUndefined();
      // 🔒 And the type a person chose is untouched — the protection said at the write rather than
      // at the door (docs/03 §3.3.10).
      expect(document.typeId).toBe('documentType-2');
      expect(document.typeSource).toBe('MANUAL');
      // What the model would have chosen is on record and applied nowhere; everything else it read
      // lands as usual.
      expect(document.auto.typeSlug).toBe('invoice');
      expect(document.country).toBe('ME');
      // And the model was told what the document already is, as a confirmed value.
      expect(analyst.calls).toHaveLength(1);
      expect(analyst.calls[0]?.confirmed.typeSlug).toBe('contract');
    });

    it('skips itself when no analyst is configured', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.configured = false;

      await run();

      expect(stateOf().steps.analysis).toBe('SKIPPED');
      expect(stateOf().processingError).toBeNull();
    });

    it('reads the place out of what a document is about, not out of the words in it', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        title: 'Ticket',
      });
      // A real Montenegrin train ticket: the country is nowhere in the text, only in what "ŽPCG"
      // means to a reader who knows the railway.
      pdfs.defaultMarkdown = 'ŽPCG · PODGORICA — BAR · 2. razred · 3,20 EUR';
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: ['sr-Latn'],
        country: 'ME',
        city: 'Podgorica',
        people: [],
        date: null,
        subjects: [],
        textQuality: null,
        legibility: null,
        extraction: null,
      };

      await run();

      const document = stateOf();
      expect(document.country).toBe('ME');
      expect(document.city).toBe('Podgorica');
      // Too little text for the offline detector to have found anything, so the analyst's answer
      // is what the document ends up with.
      expect(document.languages).toEqual(['sr-Latn']);
    });

    it('adds the people it read, creating the ones the catalogue has never seen', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await people.create({ name: 'Evgenii Shershnev' });
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: [],
        country: null,
        city: null,
        // One the catalogue has, spelled differently, and one it has never seen.
        people: ['evgenii shershnev', 'Marija Petrović'],
        date: null,
        subjects: [],
        textQuality: null,
        legibility: null,
        extraction: null,
      };

      await run();

      // 🔒 Matched case-insensitively, so a document does not double the catalogue every time the
      // model changes its capitalisation (docs/03 §3.3.19).
      expect(people.people.size).toBe(2);
      const linked = await people.listForDocument(DOCUMENT_ID);
      expect(linked.map((person) => person.name).sort()).toEqual([
        'Evgenii Shershnev',
        'Marija Petrović',
      ]);
      expect(stateOf().auto.people).toEqual(['evgenii shershnev', 'Marija Petrović']);
    });

    it('files the document under what it is about, creating the thing when it is new', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: [],
        country: null,
        city: null,
        people: [],
        date: null,
        subjects: [
          { kind: 'apartment', name: 'Njegoševa 5, ap. 12' },
          // The same thing said twice, differently cased: one row, not two.
          { kind: 'Apartment', name: 'njegoševa 5, AP. 12' },
        ],
        textQuality: null,
        legibility: null,
        extraction: null,
      };

      await run();

      expect(subjects.subjects.size).toBe(1);
      const linked = await subjects.listForDocument(DOCUMENT_ID);
      expect(linked[0]).toMatchObject({ kind: 'apartment', name: 'Njegoševa 5, ap. 12' });
    });

    it('takes the date the document carries, and leaves one that was set by hand', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: [],
        country: null,
        city: null,
        people: [],
        date: '2026-07-25',
        subjects: [],
        textQuality: null,
        legibility: null,
        extraction: null,
      };

      await run();
      expect(stateOf().documentDate).toBe('2026-07-25');

      // A second run over a document that now has a date leaves it alone and records the answer,
      // like every other field the analysis fills (docs/03 §3.3.10).
      analyst.answer = { ...analyst.answer, date: '2019-01-01' };
      await run();
      expect(stateOf().documentDate).toBe('2026-07-25');
      expect(stateOf().auto.date).toBe('2019-01-01');
    });

    it('leaves the people a person chose, and records what it read instead', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      const chosen = await people.create({ name: 'Somebody Else' });
      await people.setForDocument(DOCUMENT_ID, [chosen.id]);
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: [],
        country: null,
        city: null,
        people: ['Marija Petrović'],
        date: null,
        subjects: [],
        textQuality: null,
        legibility: null,
        extraction: null,
      };

      await run();

      // Fill-blanks-only, the rule the rest of the analysis follows (docs/03 §3.3.10).
      const linked = await people.listForDocument(DOCUMENT_ID);
      expect(linked.map((person) => person.name)).toEqual(['Somebody Else']);
      expect(stateOf().auto.people).toEqual(['Marija Petrović']);
    });

    it('leaves alone every field that already has an answer', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        country: 'RS',
        city: 'Belgrade',
      });
      pdfs.defaultMarkdown =
        'Настоящий договор заключён между сторонами третьего августа две тысячи двадцать шестого ' +
        'года и вступает в силу с момента подписания. Исполнитель обязуется обеспечить ' +
        'сохранность документов и ежемесячную отчётность заказчику.';
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: ['en'],
        country: 'ME',
        city: 'Podgorica',
        people: [],
        date: null,
        subjects: [],
        textQuality: null,
        legibility: null,
        extraction: null,
      };

      await run();

      const document = stateOf();
      // 🔒 A place a person filled in is not a blank to be overwritten (docs/03 §3.3.10), and the
      // offline detector — which read the whole text, not a 4000-character excerpt — outranks the
      // model on the question of what script is on the page.
      expect(document.country).toBe('RS');
      expect(document.city).toBe('Belgrade');
      expect(document.languages).toEqual(['ru']);
    });

    it('names the document, because a file name is not a title anybody chose', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        title: 'IMG_20260714_113355',
      });
      analyst.answer = { ...analyst.answer, title: 'Rental agreement, Njegoševa 12' };

      await run();

      const document = stateOf();
      expect(document.title).toBe('Rental agreement, Njegoševa 12');
      // AUTO, so the next run may improve on it and the viewer can say who called it that.
      expect(document.titleSource).toBe('AUTO');
      expect(document.auto.title).toBe('Rental agreement, Njegoševa 12');
    });

    it('never renames a document a person titled, and records what it would have called it', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        title: 'The flat, everything about it',
        titleSource: 'MANUAL',
      });
      analyst.answer = { ...analyst.answer, title: 'Rental agreement, Njegoševa 12' };

      await run();

      const document = stateOf();
      // 🔒 A title somebody typed is theirs (docs/03 §3.3.10).
      expect(document.title).toBe('The flat, everything about it');
      expect(document.titleSource).toBe('MANUAL');
      // And the reader still gets to see what the machine read.
      expect(document.auto.title).toBe('Rental agreement, Njegoševa 12');
    });

    it('describes what the document is, and leaves a description somebody wrote', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.answer = {
        ...analyst.answer,
        description: 'A one-year lease of a flat in Podgorica.',
      };

      await run();
      expect(stateOf().description).toBe('A one-year lease of a flat in Podgorica.');

      // A second run over a document that now has one leaves it alone — a blank is what gets filled
      // (docs/03 §3.3.10) — while still recording what was read.
      analyst.answer = { ...analyst.answer, description: 'Something else entirely.' };
      await run();
      expect(stateOf().description).toBe('A one-year lease of a flat in Podgorica.');
      expect(stateOf().auto.description).toBe('Something else entirely.');
    });

    it('records a provider failure as a step failure, leaving the rest of the run intact', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('FAILED');
      expect(document.failedStep).toBe('analysis');
      expect(document.processingError).toContain('500');
      // The document is still readable and still gets its vectors.
      expect(document.steps.markdown).toBe('DONE');
      expect(document.steps.vectorization).toBe('DONE');
    });
  });

  // An outage is not a verdict (docs/05 §5.4e): a service being away puts the step back to QUEUED
  // and carries the error out to pg-boss, so the retry is the queue's and never a person's.
  describe('an outage is not a verdict (docs/05 §5.4e)', () => {
    it('puts an interrupted markdown step back to QUEUED and rethrows, recording no failure', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.unavailable = true;

      await expect(run()).rejects.toThrow('unreachable');

      const document = stateOf();
      // The steps before it keep what they earned; the interrupted one is honestly back in the
      // queue, because the rethrow above is the retry being scheduled.
      expect(document.steps.canonical).toBe('DONE');
      expect(document.steps.preview).toBe('DONE');
      expect(document.steps.markdown).toBe('QUEUED');
      expect(document.processingError).toBeNull();
      expect(document.failedStep).toBeNull();
    });

    it('does the same for the canonical when Stirling is away', async () => {
      await givenDocument([
        { file: { mimeType: 'application/msword', ext: 'doc' }, bytes: 'doc-bytes' },
      ]);
      pdfs.unavailable = true;

      await expect(run()).rejects.toThrow('unreachable');

      const document = stateOf();
      expect(document.steps.canonical).toBe('QUEUED');
      expect(document.processingError).toBeNull();
      expect(document.failedStep).toBeNull();
    });

    it('does the same for the analysis, leaving what the run already earned', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      analyst.unavailable = true;

      await expect(run()).rejects.toThrow('unreachable');

      const document = stateOf();
      expect(document.steps.markdown).toBe('DONE');
      expect(document.steps.analysis).toBe('QUEUED');
      // The steps behind the interrupted one never started this attempt.
      expect(document.steps.vectorization).not.toBe('DONE');
      expect(document.processingError).toBeNull();
    });

    it('does the same for the vectorization', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      embeddings.unavailable = true;

      await expect(run()).rejects.toThrow('unreachable');

      const document = stateOf();
      expect(document.steps.analysis).toBe('DONE');
      expect(document.steps.vectorization).toBe('QUEUED');
      expect(document.processingError).toBeNull();
    });

    it('leaves the transcriber best-effort: its outage falls back to the recognised text', async () => {
      transcriber.configured = true;
      transcriber.unavailable = true;
      settings.transcriberMaxPages = 20;
      pdfs.pageCount = 1;
      pdfs.markdownByContent.set('image-pdf(photo)', '1\n\n2');
      pdfs.markdownByContent.set('scaled-A4-PORTRAIT(ocr-pdf)', 'Recognized text from the scan');
      await givenDocument([{ file: { mimeType: 'image/jpeg', ext: 'jpg' }, bytes: 'photo' }]);

      await run();

      // Nothing rethrown and nothing queued again: the step had its answer without the model
      // (docs/05 §5.5 step 3).
      expect(stateOf().steps.markdown).toBe('DONE');
      expect(stateOf().markdown).toBe('Recognized text from the scan');
    });

    it('still fails the document on a failure the document owns', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      // A 500 is the service answering — that document broke it (docs/05 §5.4e).
      parser.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('FAILED');
      expect(document.failedStep).toBe('markdown');
      expect(document.processingError).toContain('500');
    });
  });

  // What a person confirmed travels with every later reading (docs/05 §5.5 step 4): the values
  // whose column names who chose them, and the ones whose only trace of a correction is that they
  // differ from what the machine recorded reading.
  describe('what a person confirmed (docs/05 §5.5 step 4)', () => {
    it('carries a MANUAL title, type and field, and a place that diverged from what was read', async () => {
      const receipt = documentTypes.add('receipt');
      // What this run reads: the same place it read last time, so `autoValues` is unmoved by it and
      // both steps of the run are shown the same block.
      analyst.answer = { ...analyst.answer, country: 'RS', city: 'Podgorica' };
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        title: 'The flat, everything about it',
        titleSource: 'MANUAL',
        typeId: receipt.id,
        typeSource: 'MANUAL',
        country: 'ME',
        // Written by the pipeline itself and never touched since: identical to what it read, so it
        // is not a person's hand and does not travel.
        city: 'Podgorica',
        documentDate: '2026-05-12',
        extracted: {
          schema: { slug: 'receipt', version: 1 },
          values: { vendor: 'Voli', purchasedAt: '2026-05-12' },
          sources: { vendor: 'MANUAL', purchasedAt: 'AUTO' },
        },
        auto: { country: 'RS', city: 'Podgorica' },
      });

      await run();

      // Every kind of confirmation in one block, and nothing else in it.
      expect(analyst.calls[0]?.confirmed).toEqual({
        title: 'The flat, everything about it',
        typeSlug: 'receipt',
        date: '2026-05-12',
        country: 'ME',
        fields: { vendor: 'Voli' },
      });
      // The fields step is shown the same block (docs/05 §5.5 step 5).
      expect(analyst.fieldCalls[0]?.confirmed).toEqual(analyst.calls[0]?.confirmed);
    });

    it('carries the people and the subjects a person put on the document instead of the ones read', async () => {
      const chosen = await people.create({ name: 'Somebody Else' });
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        auto: { people: ['Marija Petrović'] },
      });
      await people.setForDocument(DOCUMENT_ID, [chosen.id]);

      await run();

      expect(analyst.calls[0]?.confirmed).toEqual({ people: ['Somebody Else'] });
    });

    it('carries nothing at all about a document nobody has touched', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        // Exactly what an earlier run of the pipeline leaves: the row and the record agree.
        country: 'ME',
        city: 'Podgorica',
        documentDate: '2026-05-12',
        description: 'A one-year lease.',
        auto: {
          country: 'ME',
          city: 'Podgorica',
          date: '2026-05-12',
          description: 'A one-year lease.',
        },
      });

      await run();

      // Most of an archive, and it costs the prompt nothing.
      expect(analyst.calls[0]?.confirmed).toEqual({});
    });

    it('keeps a confirmed field byte for byte across a re-run, and shows it to the model', async () => {
      const receipt = documentTypes.add('receipt');
      const confirmed = {
        vendor: 'Voli',
        total: { amount: 12.4, currency: 'EUR' },
      };
      analyst.fieldValues = { vendor: 'Model corp', total: { amount: 99, currency: 'USD' } };
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        typeId: receipt.id,
        typeSource: 'MANUAL',
        extracted: {
          schema: { slug: 'receipt', version: 1 },
          values: { ...confirmed },
          sources: { vendor: 'MANUAL', total: 'MANUAL' },
        },
      });

      await run();
      await run();

      // 🔒 Fill-blanks per field is untouched by any of this: the block changes what the model is
      // told, never what may be overwritten (docs/05 §5.5 step 5).
      expect(stateOf().extracted?.values).toEqual(confirmed);
      expect(stateOf().extracted?.sources).toEqual({ vendor: 'MANUAL', total: 'MANUAL' });
      // And both runs were told what those fields already are.
      expect(analyst.fieldCalls[0]?.confirmed.fields).toEqual(confirmed);
      expect(analyst.fieldCalls[1]?.confirmed.fields).toEqual(confirmed);
    });
  });

  describe('vectorization (docs/05 §5.5 step 5)', () => {
    it('chunks the Markdown, embeds it, and stores the vectors', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.defaultMarkdown = '# Contract\n\nThe parties agree.\n\nPayment is monthly.';

      await run();

      expect(stateOf().steps.vectorization).toBe('DONE');
      const stored = chunks.chunksOf(DOCUMENT_ID);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ index: 0, charCount: stored[0]?.content.length });
      expect(stored[0]?.embedding).toHaveLength(3);
      expect(embeddings.batches[0]).toEqual([stored[0]?.content]);
    });

    it('replaces the whole set on a re-run rather than adding to it', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.defaultMarkdown = 'First body, long enough to be worth keeping as a chunk.';
      await run();

      pdfs.defaultMarkdown = 'A different body entirely, also long enough to be a chunk.';
      await run();

      expect(chunks.chunksOf(DOCUMENT_ID).map((chunk) => chunk.content)).toEqual([
        'A different body entirely, also long enough to be a chunk.',
      ]);
      // 🔒 Two runs, two wholesale replacements — never a merge of the two (docs/03 §3.3.11).
      expect(chunks.replacements).toBe(2);
    });

    it('skips itself when no provider is configured, and touches no vectors', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      embeddings.configured = false;

      await run();

      expect(stateOf().steps.vectorization).toBe('SKIPPED');
      expect(stateOf().processingError).toBeNull();
      expect(chunks.replacements).toBe(0);
    });

    it('drops the vectors of a document that no longer has any text', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await run();
      expect(chunks.chunksOf(DOCUMENT_ID)).toHaveLength(1);

      // The composition changed and the new canonical says nothing at all.
      pdfs.defaultMarkdown = '';
      pdfs.markdownByContent.set('ocr-pdf', '');
      await run();

      // Otherwise search would keep returning the document by text it no longer has.
      expect(stateOf().steps.vectorization).toBe('SKIPPED');
      expect(chunks.chunksOf(DOCUMENT_ID)).toEqual([]);
    });

    it('records a provider failure as a step failure and writes nothing', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      embeddings.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.vectorization).toBe('FAILED');
      expect(document.failedStep).toBe('vectorization');
      expect(document.processingError).toContain('500');
      expect(chunks.chunksOf(DOCUMENT_ID)).toEqual([]);
    });

    it('splits a long body into several chunks, numbered in order', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      const paragraph = (label: string): string => `${label}. ${'word '.repeat(30).trim()}.`;
      pdfs.defaultMarkdown = [paragraph('One'), paragraph('Two'), paragraph('Three')].join('\n\n');

      await run();

      const stored = chunks.chunksOf(DOCUMENT_ID);
      expect(stored.length).toBeGreaterThan(1);
      expect(stored.map((chunk) => chunk.index)).toEqual(stored.map((_, index) => index));
      expect(embeddings.batches[0]).toHaveLength(stored.length);
    });
  });

  // 🔒 Steps 4 and 5 have no input of their own: they read what step 3 wrote, so what step 3 did is
  // the first question either of them asks (docs/05 §5.5).
  describe('what the last two steps ask of step 3 (docs/05 §5.5)', () => {
    // A document whose extraction is done and settled, for the subset reprocesses below: the state
    // a run leaves behind is what the next job reads out of the database.
    const afterExtraction = (
      markdown: Document['steps']['markdown'],
      overrides: Partial<Document> = {},
    ): Partial<Document> => ({
      steps: {
        canonical: 'DONE',
        preview: 'DONE',
        markdown,
        analysis: 'DONE',
        fields: 'DONE',
        vectorization: 'DONE',
      },
      ...overrides,
    });

    it('takes both of them down with an extraction that failed, and keeps step 3 as the cause', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('FAILED');
      // 🔒 Read off the row as this run left it, not off the copy the job started with: that copy
      // still said PENDING, which would have settled these two as SKIPPED instead.
      expect(document.steps.analysis).toBe('FAILED');
      expect(document.steps.vectorization).toBe('FAILED');
      // Neither provider was asked anything at all.
      expect(analyst.calls).toEqual([]);
      expect(embeddings.batches).toEqual([]);
      // 🔒 The recorded reason stays the one step 3 hit: a root cause replaced by its consequence is
      // a root cause nobody can find (docs/03 §3.3.10).
      expect(document.failedStep).toBe('markdown');
      expect(document.processingError).toContain('toMarkdown failed');
      // Settled through the same door as every other outcome, so the journal has both entries.
      const finished = events.events.filter(
        (event) => event.type === 'STEP_FINISHED' && event.payload?.step === 'vectorization',
      );
      expect(finished).toHaveLength(1);
      expect(finished[0]?.payload?.status).toBe('FAILED');
    });

    it("leaves an earlier run's vectors alone, and never analyses the Markdown it left", async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await run();
      const embedded = chunks.chunksOf(DOCUMENT_ID).map((chunk) => chunk.content);
      expect(embedded).toHaveLength(1);
      analyst.calls.length = 0;
      embeddings.batches.length = 0;

      // The next run cannot read the document at all — and the `markdown` column is deliberately not
      // cleared when the step fails, which is what the analysis used to report DONE over.
      parser.configured = true;
      parser.failing = true;
      await run();

      expect(stateOf().markdown).toBe(TEXT_LAYER);
      expect(analyst.calls).toEqual([]);
      // 🔒 The one case where the chunks are not touched at all: a run that learnt nothing is no
      // reason for a findable document to stop being findable (docs/05 §5.5).
      expect(chunks.chunksOf(DOCUMENT_ID).map((chunk) => chunk.content)).toEqual(embedded);
      expect(chunks.replacements).toBe(1);
    });

    it('asks the dependency before either step asks anything of itself', async () => {
      settings.analystAutoMaxPages = 10;
      pdfs.pageCount = 40;
      embeddings.configured = false;
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.failing = true;

      await run();

      // 🔒 A forty-page document whose extraction failed reads as a failed extraction rather than as
      // one too long to analyse, and an instance with no embeddings provider reads as the failure
      // rather than as NOT_CONFIGURED — the reason recorded is the one somebody can act on.
      const document = stateOf();
      expect(document.steps.analysis).toBe('FAILED');
      expect(document.steps.vectorization).toBe('FAILED');
      expect(document.skipReasons.analysis).toBeUndefined();
      expect(document.skipReasons.vectorization).toBeUndefined();
    });

    it('inherits the reason step 3 recorded when the extraction was skipped', async () => {
      await givenDocument(
        [{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }],
        afterExtraction('SKIPPED', { skipReasons: { markdown: 'UNSUPPORTED_FORMAT' } }),
      );

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['analysis', 'vectorization'] });

      const document = stateOf();
      // 🔒 The reader is told the format could not be rendered rather than that the embeddings found
      // nothing (docs/03 §3.3.10).
      expect(document.steps.analysis).toBe('SKIPPED');
      expect(document.steps.vectorization).toBe('SKIPPED');
      expect(document.skipReasons.analysis).toBe('UNSUPPORTED_FORMAT');
      expect(document.skipReasons.vectorization).toBe('UNSUPPORTED_FORMAT');
      expect(analyst.calls).toEqual([]);
      expect(chunks.replacements).toBe(0);
    });

    it('falls back to NO_TEXT when the skip carried no reason to inherit', async () => {
      await givenDocument(
        [{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }],
        afterExtraction('SKIPPED'),
      );

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['analysis', 'vectorization'] });

      const document = stateOf();
      expect(document.skipReasons.analysis).toBe('NO_TEXT');
      expect(document.skipReasons.vectorization).toBe('NO_TEXT');
    });

    it('fails an analysis asked for on its own over an extraction that failed', async () => {
      await givenDocument(
        [{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }],
        afterExtraction('FAILED', {
          processingError: 'Docling toMarkdown failed with 500',
          failedStep: 'markdown',
        }),
      );

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['analysis'] });

      const document = stateOf();
      expect(document.steps.analysis).toBe('FAILED');
      expect(analyst.calls).toEqual([]);
      // 🔒 This run cannot re-run step 3, so what step 3 recorded outlives it: the field that says
      // why there is nothing to analyse is not the analysis's to empty (docs/07 §7.3).
      expect(document.failedStep).toBe('markdown');
      expect(document.processingError).toBe('Docling toMarkdown failed with 500');
      // Not asked for, so not touched (docs/07 §7.3).
      expect(document.steps.vectorization).toBe('DONE');
    });

    it('skips a vectorization asked for on its own where nothing has been extracted yet', async () => {
      await givenDocument(
        [{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }],
        afterExtraction('PENDING'),
      );

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['vectorization'] });

      const document = stateOf();
      // "Not extracted yet" is not text either — the state a reprocess of step 5 alone leaves a
      // document that never had an extraction in (docs/03 §3.3.10).
      expect(document.steps.vectorization).toBe('SKIPPED');
      expect(document.skipReasons.vectorization).toBe('NO_TEXT');
      expect(embeddings.batches).toEqual([]);
      expect(chunks.replacements).toBe(0);
    });

    it('still analyses a document that was read and found to have nothing on it', async () => {
      await givenDocument([{ file: { mimeType: 'image/png', ext: 'png' }, bytes: 'photo' }]);
      pdfs.markdownByContent.set('image-pdf(photo)', '');
      pdfs.markdownByContent.set('ocr-pdf', '');
      pdfs.markdownByContent.set('scaled-A4-PORTRAIT(ocr-pdf)', '');

      await run();

      const document = stateOf();
      // DONE with empty text is a document that *was* read and had no text to give — a fact about
      // the document rather than a gap in the pipeline (docs/05 §5.5).
      expect(document.steps.markdown).toBe('DONE');
      expect(document.markdown).toBeNull();
      // The analysis has the pages as pictures, so it still runs.
      expect(document.steps.analysis).toBe('DONE');
      expect(analyst.calls).toHaveLength(1);
      // And the vectorization clears the chunks, because search must not return a document by text
      // it no longer has — the opposite of what the dependency above does with them.
      expect(document.steps.vectorization).toBe('SKIPPED');
      expect(document.skipReasons.vectorization).toBe('NO_TEXT');
      expect(chunks.replacements).toBe(1);
      expect(chunks.chunksOf(DOCUMENT_ID)).toEqual([]);
    });
  });

  describe('reprocessing a subset of steps (docs/07 §7.3)', () => {
    it('runs only the requested step and leaves the others exactly as they were', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await run();
      const before = stateOf();
      pdfs.calls.length = 0;
      pdfs.markdownReads.length = 0;

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['preview'] });

      const after = stateOf();
      expect(after.steps.preview).toBe('DONE');
      // Nothing else was touched: the Markdown is the one from the first run, not re-extracted.
      expect(after.markdown).toBe(before.markdown);
      expect(pdfs.markdownReads).toHaveLength(0);
      expect(analyst.calls).toHaveLength(1);
      expect(chunks.replacements).toBe(1);
    });

    it('re-reads the canonical for a later step instead of assembling it again', async () => {
      await givenDocument([
        { file: { mimeType: 'application/rtf', ext: 'rtf' }, bytes: 'rtf-bytes' },
      ]);
      pdfs.markdownByContent.set(
        'converted-pdf',
        'Converted body text that is long enough to trust',
      );
      await run();
      pdfs.calls.length = 0;

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['markdown'] });

      // 🔒 The original is not converted a second time; step 3 reads what step 1 already wrote to
      // the bucket (docs/07 §7.3).
      expect(methodsCalled()).not.toContain('toPdf');
      expect(stateOf().markdown).toBe('Converted body text that is long enough to trust');
      expect(stateOf().steps.canonical).toBe('DONE');
    });

    it('fails a step that depends on a canonical which was never produced', async () => {
      await givenDocument([
        { file: { mimeType: 'application/msword', ext: 'doc' }, bytes: 'doc-bytes' },
      ]);
      pdfs.failOn('toPdf');
      await run();
      pdfs.failures.clear();

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['markdown'] });

      expect(stateOf().steps.markdown).toBe('FAILED');
    });

    it('settles only the requested steps of a document nothing can render', async () => {
      await givenDocument([
        { file: { mimeType: 'application/x-executable', ext: 'bin' }, bytes: 'binary' },
      ]);

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['canonical', 'preview'] });

      const document = stateOf();
      expect(document.steps.preview).toBe('SKIPPED');
      // Never asked for, never written.
      expect(document.steps.markdown).toBe('PENDING');
      expect(analyst.calls).toEqual([]);
    });

    it('clears the recorded failure when it re-runs the step that owns it', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.failing = true;
      await run();
      expect(stateOf().failedStep).toBe('markdown');

      parser.failing = false;
      parser.markdown = TEXT_LAYER;
      await handler.handle({ documentId: DOCUMENT_ID, steps: ['markdown'] });

      // The attempt that replaces a failure takes its record with it — which is the whole of what
      // the clean slate was ever for (docs/07 §7.3).
      const document = stateOf();
      expect(document.steps.markdown).toBe('DONE');
      expect(document.failedStep).toBeNull();
      expect(document.processingError).toBeNull();
    });

    it('records the failure of a step it was asked for, over the one it had to keep', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.failing = true;
      await run();
      pdfs.failOn('pdfPageJpg');

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['preview'] });

      // Keeping an error a run may not clear is not the same as refusing to record a new one: the
      // step this run did ask for owns the field now (docs/03 §3.3.10).
      const document = stateOf();
      expect(document.steps.preview).toBe('FAILED');
      expect(document.failedStep).toBe('preview');
      expect(document.processingError).toContain('pdfPageJpg failed');
    });

    it('rejects a step name the pipeline does not have', async () => {
      await givenDocument();

      await expect(
        handler.handle({ documentId: DOCUMENT_ID, steps: ['thumbnail'] }),
      ).rejects.toThrow();
    });
  });

  describe('idempotency', () => {
    it('rewrites artifacts and statuses on a re-run without duplicating anything', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();
      await run();

      expect(storage.keys()).toEqual([
        artifactKeys.canonicalPdf(DOCUMENT_ID),
        artifactKeys.preview(DOCUMENT_ID),
        artifactKeys.thumbnail(DOCUMENT_ID),
      ]);
      expect(stateOf().steps.preview).toBe('DONE');
      // Twice through the same path: two renders, two pairs of resizes, one set of objects.
      expect(pdfs.calls.filter((call) => call.method === 'pdfPageJpg')).toHaveLength(2);
      expect(images.resizes).toHaveLength(4);
      expect(stateOf().steps.markdown).toBe('DONE');
    });

    it('clears an earlier failure when the re-run succeeds', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      pdfs.failOn('pdfPageJpg');
      await run();
      expect(stateOf().failedStep).toBe('preview');

      pdfs.failures.clear();
      await run();

      const document = stateOf();
      expect(document.steps.preview).toBe('DONE');
      expect(document.failedStep).toBeNull();
      expect(document.processingError).toBeNull();
    });

    it('does nothing for a document that was soft-deleted before the job ran', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        deletedAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      await run();

      expect(documents.updates).toEqual([]);
      expect(storage.keys()).toEqual([]);
    });

    it('ignores a job for a document that no longer exists', async () => {
      await expect(run(GONE_ID)).resolves.toBeUndefined();
    });
  });

  // A step this instance is holding (docs/05 §5.4d). Held, not skipped: the row keeps what it had,
  // and the steps beside it go on running.
  describe('a paused step (docs/05 §5.4d)', () => {
    it('leaves the held step untouched while the steps beside it run and settle', async () => {
      await pauseSteps('analysis');
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('DONE');
      expect(document.steps.preview).toBe('DONE');
      expect(document.steps.markdown).toBe('DONE');
      // 🔒 Nothing at all was written about the held step: not a status, not a skip reason, not an
      // entry in the journal. A step that has not run has reached no verdict to record.
      expect(document.steps.analysis).toBe('PENDING');
      expect(document.skipReasons.analysis).toBeUndefined();
      expect(events.events.filter((event) => event.payload?.step === 'analysis')).toEqual([]);
      // And the analyst was never called.
      expect(analyst.calls).toHaveLength(0);
    });

    it('holds the steps that read the canonical when the canonical is held with them', async () => {
      await pauseSteps('canonical');
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      const document = stateOf();
      // 🔒 Not FAILED: there is no canonical because nobody was allowed to build one, which is a
      // fact about the switch rather than about the document.
      expect(document.steps.canonical).toBe('PENDING');
      expect(document.steps.preview).toBe('PENDING');
      expect(document.steps.markdown).toBe('PENDING');
      expect(document.steps.vectorization).toBe('PENDING');
      expect(storage.keys()).toEqual([]);
    });

    it('runs the steps that read the canonical when an earlier run built one', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      await run();
      const built = canonicalOf();

      await pauseSteps('canonical');
      pdfs.calls.length = 0;
      await run();

      // The canonical in the bucket is the one the first run made — nothing rebuilt it — and the
      // steps that read it ran over it again.
      expect(canonicalOf()).toBe(built);
      expect(stateOf().steps.preview).toBe('DONE');
      expect(stateOf().steps.markdown).toBe('DONE');
    });

    it('holds the fields step behind a held analysis only until the document has a type', async () => {
      const receipt = documentTypes.add('receipt');
      await pauseSteps('analysis');
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);

      await run();

      // Nothing decided the type, so "this type has no schema" would be a verdict about a type
      // nobody has read.
      expect(stateOf().steps.fields).toBe('PENDING');
      expect(stateOf().skipReasons.fields).toBeUndefined();

      // A person chooses one: the fields are a reading under *that* type, and the analysis is not
      // needed for it.
      documents.add({ ...stateOf(), typeId: receipt.id, typeSource: 'MANUAL' });
      await run();

      expect(stateOf().steps.fields).toBe('DONE');
      expect(stateOf().steps.analysis).toBe('PENDING');
    });

    it('writes nothing at all when every step it was asked for is held', async () => {
      await pauseSteps('vectorization');
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      documents.updates.length = 0;

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['vectorization'] });

      expect(documents.updates).toEqual([]);
      expect(stateOf().steps.vectorization).toBe('PENDING');
    });
  });

  it('rejects a payload that is not a document id', async () => {
    await expect(handler.handle({ id: DOCUMENT_ID })).rejects.toThrow();
  });

  // The same handler with a different unit concurrency, for the one test that cares.
  function withUnitConcurrency(unitConcurrency: number): HandleDocumentProcess {
    const settings = {
      previewMaxDim: PREVIEW_MAX_DIM,
      thumbMaxDim: THUMB_MAX_DIM,
      ocrLanguages: ['rus', 'eng'],
      pdfTextMinCharsPerPage: MIN_CHARS_PER_PAGE,
      correctImagePages: true,
      chunkTargetChars: 200,
      chunkOverlapChars: 40,
      analystExcerptChars: 0,
      analystMaxPageImages: 20,
      analystPageImageMaxDim: 1200,
      analystAutoMaxPages: 0,
      transcriberMaxPages: 0,
      transcriberPageImageMaxDim: 1600,
    };
    return new HandleDocumentProcess(
      documents,
      events,
      new BuildCanonical(
        fileRepo,
        fileRefs,
        libraries,
        reader,
        storage,
        images,
        pdfs,
        queueSettingsFixture(unitConcurrency),
        settings,
      ),
      storage,
      pdfs,
      parser,
      images,
      documentTypes,
      analyst,
      transcriber,
      people,
      subjects,
      subjectKinds,
      chunks,
      embeddings,
      new ImmediateUnitOfWork(),
      calls,
      new AnalysisSettings(new InMemorySettingsRepository()),
      queueSettingsFixture(unitConcurrency, queueStore),
      settings,
      new FixedClock(),
    );
  }
});
