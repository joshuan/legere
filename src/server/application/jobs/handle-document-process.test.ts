import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  documentFixture,
  LIBRARY_ID,
  FakeAnalyst,
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
  InMemoryLibraryRepository,
  libraryFixture,
  StubLibraryReader,
} from '../../../../test/helpers/processing-fakes';
import type { Document } from '../../domain/entities/document';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { artifactKeys } from '../storage/artifact-keys';
import { HandleDocumentProcess } from './handle-document-process';

const PREVIEW_MAX_DIM = 1600;
const THUMB_MAX_DIM = 400;
const SOURCE_PATH = 'invoices/a.pdf';
const DERIVED_ID = '33333333-3333-4333-8333-333333333333';
const MIN_CHARS_PER_PAGE = 32;
// Comfortably above the threshold, so the default PDF path is "has a text layer".
const TEXT_LAYER = 'Invoice 2026-01 for services rendered in January, payable within 30 days.';
const GONE_ID = '44444444-4444-4444-8444-444444444444';

// Steps 1–2 of docs/05 §5.5 with the containers and the bucket replaced by in-memory doubles: what
// is asserted here is the routing, the artifacts and the statuses — the ports themselves are covered
// by their own suites.
describe('HandleDocumentProcess', () => {
  let documents: InMemoryDocumentRepository;
  let events: FakeDocumentEventRepository;
  let fileRefs: InMemoryFileRefRepository;
  let libraries: InMemoryLibraryRepository;
  let reader: StubLibraryReader;
  let files: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let parser: FakeDocumentParser;
  let images: FakeImageTool;
  let documentTypes: InMemoryCategoryRepository;
  let analyst: FakeAnalyst;
  let people: InMemoryPersonRepository;
  let subjects: InMemorySubjectRepository;
  let subjectKinds: InMemorySubjectKindRepository;
  let chunks: InMemoryDocumentChunkRepository;
  let embeddings: FakeEmbeddingProvider;
  let calls: FakeCallContext;
  let handler: HandleDocumentProcess;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    events = new FakeDocumentEventRepository();
    fileRefs = new InMemoryFileRefRepository();
    libraries = new InMemoryLibraryRepository();
    reader = new StubLibraryReader();
    files = new InMemoryFileStorage();
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
    reader.put(SOURCE_PATH, 'source-bytes');

    handler = new HandleDocumentProcess(
      documents,
      events,
      fileRefs,
      libraries,
      reader,
      files,
      pdfs,
      parser,
      images,
      documentTypes,
      analyst,
      people,
      subjects,
      subjectKinds,
      chunks,
      embeddings,
      new ImmediateUnitOfWork(),
      calls,
      {
        previewMaxDim: PREVIEW_MAX_DIM,
        thumbMaxDim: THUMB_MAX_DIM,
        ocrLanguages: ['rus', 'eng'],
        pdfTextMinCharsPerPage: MIN_CHARS_PER_PAGE,
        chunkTargetChars: 200,
        chunkOverlapChars: 40,
      },
    );
  });

  // A library document with one live file ref pointing at the stub volume.
  function givenDocument(overrides: Partial<Document> = {}): Document {
    const document = documents.add(documentFixture(overrides));
    fileRefs.add({ id: `ref-${document.id}`, libraryId: LIBRARY_ID, documentId: document.id });
    return document;
  }

  const run = (documentId = DOCUMENT_ID): Promise<void> => handler.handle({ documentId });

  const stateOf = (id = DOCUMENT_ID): Document => {
    const document = documents.documents.get(id);
    if (document === undefined) throw new Error(`No document ${id}`);
    return document;
  };

  describe('the format matrix (docs/05 §5.5)', () => {
    it('a PDF needs no canonicalization and previews from the source', async () => {
      givenDocument({ mimeType: 'application/pdf', ext: 'pdf' });
      pdfs.pageCount = 12;
      // A dozen pages carrying a dozen pages' worth of text. The threshold is per page now, so one
      // sentence spread over twelve pages would (correctly) be read as a scan.
      pdfs.defaultMarkdown = `${TEXT_LAYER}\n\n`.repeat(12);

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('SKIPPED');
      expect(document.steps.preview).toBe('DONE');
      expect(document.pageCount).toBe(12);
      expect(files.keys()).toEqual([
        artifactKeys.preview(DOCUMENT_ID),
        artifactKeys.thumbnail(DOCUMENT_ID),
      ]);
      // Rendering, then reading the text layer — no OCR, because the layer is worth trusting.
      // No conversion: the page count and the render for the preview, then the parse for the text —
      // all of it Stirling, none of it a second engine (docs/05 §5.5).
      expect(pdfs.calls.map((call) => call.method)).toEqual([
        'pdfPageCount',
        'pdfFirstPageJpg',
        'pdfToMarkdown',
      ]);
      expect(document.steps.markdown).toBe('DONE');
      expect(document.ocrUsed).toBe(false);
    });

    it('an office document is converted, and the preview comes from the canonical PDF', async () => {
      givenDocument({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx',
        title: 'Q1 report',
      });

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('DONE');
      expect(document.steps.preview).toBe('DONE');
      expect(files.get(artifactKeys.canonicalPdf(DOCUMENT_ID)).body.toString()).toBe(
        'canonical-pdf',
      );
      expect(files.get(artifactKeys.canonicalPdf(DOCUMENT_ID)).contentType).toBe('application/pdf');
      // The converter needs the extension to pick its input filter (docs/05 §5.5 step 1).
      expect(pdfs.calls[0]).toEqual({ method: 'officeToPdf', fileName: 'Q1 report.docx' });
      // Page count and rendering both read the canonical PDF, not the .docx.
      expect(reader.opened).toEqual([SOURCE_PATH]);
    });

    it('an image previews directly, with no PDF anywhere in the path', async () => {
      givenDocument({ mimeType: 'image/jpeg', ext: 'jpg' });

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('SKIPPED');
      expect(document.steps.preview).toBe('DONE');
      expect(document.pageCount).toBeNull();
      expect(images.resizes.map((resize) => resize.input)).toEqual([
        'source-bytes',
        'source-bytes',
      ]);
      // The only PDF work an image causes is the OCR round trip of step 3.
      expect(pdfs.calls.map((call) => call.method)).toEqual([
        'imagesToPdf',
        'ocrPdf',
        'pdfToMarkdown',
      ]);
    });

    it('plain text and Markdown skip both steps', async () => {
      givenDocument({ mimeType: 'text/markdown', ext: 'md' });

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('SKIPPED');
      expect(document.steps.preview).toBe('SKIPPED');
      expect(files.keys()).toEqual([]);
      // Text goes straight through to Markdown (docs/05 §5.5): no conversion, no rendering.
      expect(document.steps.markdown).toBe('DONE');
      expect(pdfs.calls).toEqual([]);
    });

    it('an unsupported format settles steps 1-3 and 5 without touching the tooling', async () => {
      givenDocument({ mimeType: 'application/x-executable', ext: 'bin' });

      await run();

      const document = stateOf();
      expect(document.steps).toMatchObject({
        canonical: 'SKIPPED',
        preview: 'SKIPPED',
        markdown: 'SKIPPED',
        vectorization: 'SKIPPED',
      });
      // A title is still something to classify, and 🔒 no step may be left PENDING — the document
      // would read as "still processing" for the rest of its life (docs/03 §3.3.10).
      expect(document.steps.analysis).toBe('DONE');
      expect(analyst.calls[0]?.excerpt).toBe('Invoice 2026-01');
      expect(pdfs.calls).toEqual([]);
      expect(files.keys()).toEqual([]);
    });
  });

  describe('the artifacts', () => {
    it('writes preview and thumbnail at the configured dimensions', async () => {
      givenDocument();

      await run();

      expect(images.resizes).toEqual([
        { maxDim: PREVIEW_MAX_DIM, quality: 80, input: 'rendered-page' },
        { maxDim: THUMB_MAX_DIM, quality: 75, input: 'rendered-page' },
      ]);
      expect(files.get(artifactKeys.preview(DOCUMENT_ID)).contentType).toBe('image/jpeg');
      expect(files.get(artifactKeys.thumbnail(DOCUMENT_ID)).body.toString()).toBe(
        `jpeg:${THUMB_MAX_DIM}:rendered-page`,
      );
    });

    it('reads a DERIVED document from the bucket instead of a library', async () => {
      documents.add(
        documentFixture({ id: DERIVED_ID, source: 'DERIVED', mimeType: 'application/pdf' }),
      );
      await files.put(
        artifactKeys.source(DERIVED_ID, 'pdf'),
        Buffer.from('merged'),
        'application/pdf',
      );

      await run(DERIVED_ID);

      expect(stateOf(DERIVED_ID).steps.preview).toBe('DONE');
      expect(reader.opened).toEqual([]);
    });
  });

  describe('markdown (docs/05 §5.5 step 3)', () => {
    it('reads a PDF that carries its own text, without paying for OCR', async () => {
      givenDocument({ mimeType: 'application/pdf' });

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('DONE');
      expect(document.markdown).toContain('Invoice 2026-01');
      expect(document.ocrUsed).toBe(false);
      expect(pdfs.calls.some((call) => call.method === 'ocrPdf')).toBe(false);
    });

    it('sends a PDF whose text layer is too thin to OCR', async () => {
      // A scan often carries a few stray characters — page numbers, a watermark — which is exactly
      // what PDF_TEXT_MIN_CHARS_PER_PAGE is there to see through (docs/05 §5.9).
      givenDocument({ mimeType: 'application/pdf' });
      pdfs.defaultMarkdown = ['1', '2', '3'].join('\n\n');
      pdfs.markdownByContent.set('ocr-pdf', 'The full text of the scanned page');

      await run();

      const document = stateOf();
      expect(document.ocrUsed).toBe(true);
      expect(document.markdown).toBe('The full text of the scanned page');
      expect(pdfs.calls.filter((call) => call.method === 'ocrPdf')).toHaveLength(1);
    });

    it('measures the text layer per page, not in total', async () => {
      // 200 characters spread over 20 pages is 10 per page: a scan, however long.
      givenDocument({ mimeType: 'application/pdf' });
      pdfs.defaultMarkdown = 'ten chars.'.repeat(20);
      pdfs.pageCount = 20;

      await run();

      expect(stateOf().ocrUsed).toBe(true);
    });

    it('OCRs an image through a one-page PDF', async () => {
      givenDocument({ mimeType: 'image/jpeg', ext: 'jpg', title: 'Receipt' });

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('DONE');
      expect(document.ocrUsed).toBe(true);
      expect(document.markdown).toBe('Recognized text from the scan');
      expect(pdfs.calls).toContainEqual({ method: 'imagesToPdf', fileName: 'Receipt.jpg' });
    });

    it('passes text through, normalizing what a file may carry', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      // BOM, CRLF line endings and a stray NUL — all three arrive in real files.
      reader.put(
        SOURCE_PATH,
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('# Notes\r\n\r\nSecond line\u0000\n'),
        ]),
      );

      await run();

      const document = stateOf();
      expect(document.markdown).toBe('# Notes\n\nSecond line');
      expect(document.ocrUsed).toBe(false);
      expect(pdfs.markdownReads).toEqual([]);
    });

    it('reads an office document from the canonical PDF, not from the original', async () => {
      givenDocument({ mimeType: 'application/rtf', ext: 'rtf' });
      pdfs.markdownByContent.set(
        'canonical-pdf',
        'Converted body text that is long enough to trust',
      );

      await run();

      expect(stateOf().markdown).toBe('Converted body text that is long enough to trust');
      expect(pdfs.markdownReads).toContain('canonical-pdf');
    });

    it('stores nothing rather than an empty string when OCR finds no text', async () => {
      givenDocument({ mimeType: 'image/png', ext: 'png' });
      pdfs.markdownByContent.set('ocr-pdf', ['', '   '].join('\n\n'));

      await run();

      const document = stateOf();
      // The step ran and answered "there is no text here" — that is DONE, not FAILED.
      expect(document.steps.markdown).toBe('DONE');
      expect(document.markdown).toBeNull();
      expect(document.ocrUsed).toBe(true);
    });

    it('keeps a markdown failure from touching the preview', async () => {
      givenDocument({ mimeType: 'application/pdf' });
      pdfs.markdownFailing = true;

      await run();

      const document = stateOf();
      expect(document.steps.preview).toBe('DONE');
      expect(document.steps.markdown).toBe('FAILED');
      expect(document.failedStep).toBe('markdown');
      expect(document.processingError).toContain('pdfToMarkdown failed');
    });

    it('cannot read an office document whose conversion failed', async () => {
      givenDocument({ mimeType: 'application/msword', ext: 'doc' });
      pdfs.failOn('officeToPdf');

      await run();

      const document = stateOf();
      expect(document.steps.markdown).toBe('FAILED');
      // Still the conversion error, not a second report of its consequence.
      expect(document.failedStep).toBe('canonical');
    });
  });

  it('says a step is running before it runs, so a slow one is not mistaken for a stuck one', async () => {
    givenDocument({ mimeType: 'text/plain', ext: 'txt' });
    reader.put(SOURCE_PATH, 'Amount due: 1200.');

    await run();

    // The order matters, not the count: every step is announced before it is settled (docs/03
    // §3.3.10). Parsing with picture captions takes minutes — for those minutes PENDING would read
    // as "nothing is happening".
    for (const step of ['preview', 'markdown', 'analysis', 'vectorization'] as const) {
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
    givenDocument({ mimeType: 'text/plain', ext: 'txt' });
    reader.put(SOURCE_PATH, 'Amount due: 1200.');

    await run();

    const markdown = events.events.filter((event) => event.payload?.step === 'markdown');
    expect(markdown.map((event) => event.type)).toEqual(['STEP_STARTED', 'STEP_FINISHED']);
    expect(markdown[1]?.payload?.status).toBe('DONE');

    // 🔒 A skip carries its reason into the log, or the log says "SKIPPED" as uselessly as the
    // panel used to (docs/03 §3.3.10).
    const canonical = events.events.find(
      (event) => event.payload?.step === 'canonical' && event.type === 'STEP_FINISHED',
    );
    expect(canonical?.payload).toMatchObject({ status: 'SKIPPED', reason: 'NOT_NEEDED' });
  });

  it('records a failure with the message, not just the status', async () => {
    givenDocument({ mimeType: 'text/plain', ext: 'txt' });
    reader.put(SOURCE_PATH, 'text');
    embeddings.failing = true;

    await run();

    const failed = events.events.find((event) => event.payload?.status === 'FAILED');
    expect(failed?.payload?.step).toBe('vectorization');
    expect(failed?.payload?.error).toBeDefined();
  });

  describe('analysis (docs/05 §5.5 step 4)', () => {
    it('assigns the documentType the analyst chose, marked as automatic', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt', title: 'March invoice' });
      reader.put(SOURCE_PATH, 'Amount due: 1200. Payable within 30 days.');
      analyst.slug = 'invoice';

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('DONE');
      expect(document.typeId).toBe('documentType-1');
      expect(document.typeSource).toBe('AUTO');
    });

    it('offers the analyst the slugs and the descriptions an admin wrote', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt', title: 'March invoice' });
      reader.put(SOURCE_PATH, 'Amount due: 1200.');

      await run();

      const call = analyst.calls[0];
      expect(call?.documentTypes).toEqual([
        { slug: 'invoice', name: 'invoice', description: 'Bills and payment requests.' },
        { slug: 'contract', name: 'contract', description: null },
      ]);
      // Title first, then the extracted text — the title is there even when the text is not.
      expect(call?.excerpt).toBe('March invoice\n\nAmount due: 1200.');
    });

    it('records no documentType when the model answers with a slug nobody defined', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      // 🔒 A hallucinated documentType must not become a real one (docs/05 §5.5 step 4).
      analyst.slug = 'tax-return-2019';

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('DONE');
      expect(document.typeId).toBeNull();
      expect(document.typeSource).toBe('NONE');
    });

    it('never overwrites a documentType a person chose', async () => {
      givenDocument({
        mimeType: 'text/plain',
        ext: 'txt',
        typeId: 'documentType-2',
        typeSource: 'MANUAL',
      });
      analyst.slug = 'invoice';

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('SKIPPED');
      expect(document.typeId).toBe('documentType-2');
      expect(document.typeSource).toBe('MANUAL');
      expect(analyst.calls).toEqual([]);
    });

    it('skips itself when no analyst is configured', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      analyst.configured = false;

      await run();

      expect(stateOf().steps.analysis).toBe('SKIPPED');
      expect(stateOf().processingError).toBeNull();
    });

    it('still runs with no documentTypes defined, because it also reads where the document is from', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      documentTypes.documentTypes.length = 0;
      analyst.answer = {
        title: null,
        description: null,
        typeSlug: null,
        languages: [],
        country: 'ME',
        city: 'Podgorica',
        people: [],
        date: null,
        subjects: [],
      };

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('DONE');
      expect(document.typeId).toBeNull();
      expect(document.country).toBe('ME');
    });

    it('reads the place out of what a document is about, not out of the words in it', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt', title: 'Ticket' });
      // A real Montenegrin train ticket: the country is nowhere in the text, only in what "ŽPCG"
      // means to a reader who knows the railway.
      reader.put(SOURCE_PATH, 'ŽPCG · PODGORICA — BAR · 2. razred · 3,20 EUR');
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
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'Ugovor između strana');
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
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'Ugovor o zakupu stana');
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
      };

      await run();

      expect(subjects.subjects.size).toBe(1);
      const linked = await subjects.listForDocument(DOCUMENT_ID);
      expect(linked[0]).toMatchObject({ kind: 'apartment', name: 'Njegoševa 5, ap. 12' });
    });

    it('takes the date the document carries, and leaves one that was set by hand', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'Ugovor');
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
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'text');
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
      };

      await run();

      // Fill-blanks-only, the rule the rest of the analysis follows (docs/03 §3.3.10).
      const linked = await people.listForDocument(DOCUMENT_ID);
      expect(linked.map((person) => person.name)).toEqual(['Somebody Else']);
      expect(stateOf().auto.people).toEqual(['Marija Petrović']);
    });

    it('leaves alone every field that already has an answer', async () => {
      givenDocument({
        mimeType: 'text/plain',
        ext: 'txt',
        country: 'RS',
        city: 'Belgrade',
      });
      reader.put(
        SOURCE_PATH,
        'Настоящий договор заключён между сторонами третьего августа две тысячи двадцать шестого ' +
          'года и вступает в силу с момента подписания. Исполнитель обязуется обеспечить ' +
          'сохранность документов и ежемесячную отчётность заказчику.',
      );
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
      givenDocument({ mimeType: 'text/plain', ext: 'txt', title: 'IMG_20260714_113355' });
      reader.put(SOURCE_PATH, 'text');
      analyst.answer = { ...analyst.answer, title: 'Rental agreement, Njegoševa 12' };

      await run();

      const document = stateOf();
      expect(document.title).toBe('Rental agreement, Njegoševa 12');
      // AUTO, so the next run may improve on it and the viewer can say who called it that.
      expect(document.titleSource).toBe('AUTO');
      expect(document.auto.title).toBe('Rental agreement, Njegoševa 12');
    });

    it('never renames a document a person titled, and records what it would have called it', async () => {
      givenDocument({
        mimeType: 'text/plain',
        ext: 'txt',
        title: 'The flat, everything about it',
        titleSource: 'MANUAL',
      });
      reader.put(SOURCE_PATH, 'text');
      analyst.answer = { ...analyst.answer, title: 'Rental agreement, Njegoševa 12' };

      await run();

      const document = stateOf();
      // 🔒 A title somebody typed is theirs (docs/03 §3.3.10).
      expect(document.title).toBe('The flat, everything about it');
      expect(document.titleSource).toBe('MANUAL');
      // And the reader still gets to see what the machine read.
      expect(document.auto.title).toBe('Rental agreement, Njegoševa 12');
    });

    it('leaves the file name alone when the analysis has no title to offer', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt', title: 'IMG_20260714_113355' });
      reader.put(SOURCE_PATH, 'text');
      analyst.answer = { ...analyst.answer, title: null };

      await run();

      const document = stateOf();
      // A file name is better than a title invented out of one.
      expect(document.title).toBe('IMG_20260714_113355');
      expect(document.titleSource).toBe('NONE');
      expect(document.auto.title).toBeUndefined();
    });

    it('describes what the document is, and leaves a description somebody wrote', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'text');
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
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      analyst.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.analysis).toBe('FAILED');
      expect(document.failedStep).toBe('analysis');
      expect(document.processingError).toContain('503');
      // The document is still readable and still gets its vectors.
      expect(document.steps.markdown).toBe('DONE');
      expect(document.steps.vectorization).toBe('DONE');
    });
  });

  describe('vectorization (docs/05 §5.5 step 5)', () => {
    it('chunks the Markdown, embeds it, and stores the vectors', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, '# Contract\n\nThe parties agree.\n\nPayment is monthly.');

      await run();

      expect(stateOf().steps.vectorization).toBe('DONE');
      const stored = chunks.chunksOf(DOCUMENT_ID);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ index: 0, charCount: stored[0]?.content.length });
      expect(stored[0]?.embedding).toHaveLength(3);
      expect(embeddings.batches[0]).toEqual([stored[0]?.content]);
    });

    it('replaces the whole set on a re-run rather than adding to it', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'First body.');
      await run();

      reader.put(SOURCE_PATH, 'A different body entirely.');
      await run();

      expect(chunks.chunksOf(DOCUMENT_ID).map((chunk) => chunk.content)).toEqual([
        'A different body entirely.',
      ]);
      // 🔒 Two runs, two wholesale replacements — never a merge of the two (docs/03 §3.3.11).
      expect(chunks.replacements).toBe(2);
    });

    it('skips itself when no provider is configured, and touches no vectors', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      embeddings.configured = false;

      await run();

      expect(stateOf().steps.vectorization).toBe('SKIPPED');
      expect(stateOf().processingError).toBeNull();
      expect(chunks.replacements).toBe(0);
    });

    it('drops the vectors of a document that no longer has any text', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'Something to embed.');
      await run();
      expect(chunks.chunksOf(DOCUMENT_ID)).toHaveLength(1);

      reader.put(SOURCE_PATH, '');
      await run();

      // Otherwise search would keep returning the document by text it no longer has.
      expect(stateOf().steps.vectorization).toBe('SKIPPED');
      expect(chunks.chunksOf(DOCUMENT_ID)).toEqual([]);
    });

    it('records a provider failure as a step failure and writes nothing', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      reader.put(SOURCE_PATH, 'Body to embed.');
      embeddings.failing = true;

      await run();

      const document = stateOf();
      expect(document.steps.vectorization).toBe('FAILED');
      expect(document.failedStep).toBe('vectorization');
      expect(document.processingError).toContain('500');
      expect(chunks.chunksOf(DOCUMENT_ID)).toEqual([]);
    });

    it('splits a long body into several chunks, numbered in order', async () => {
      givenDocument({ mimeType: 'text/plain', ext: 'txt' });
      const paragraph = (label: string): string => `${label}. ${'word '.repeat(30).trim()}.`;
      reader.put(
        SOURCE_PATH,
        [paragraph('One'), paragraph('Two'), paragraph('Three')].join('\n\n'),
      );

      await run();

      const stored = chunks.chunksOf(DOCUMENT_ID);
      expect(stored.length).toBeGreaterThan(1);
      expect(stored.map((chunk) => chunk.index)).toEqual(stored.map((_, index) => index));
      expect(embeddings.batches[0]).toHaveLength(stored.length);
    });
  });

  describe('failures', () => {
    it('records the failing step with its error and leaves the document usable', async () => {
      givenDocument({
        mimeType: 'application/vnd.oasis.opendocument.text',
        ext: 'odt',
        title: 'Notes',
      });
      pdfs.failOn('officeToPdf');

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('FAILED');
      expect(document.failedStep).toBe('canonical');
      expect(document.processingError).toContain('officeToPdf failed');
      expect(files.keys()).toEqual([]);
    });

    it('fails the preview when the canonical PDF it needed was never produced', async () => {
      givenDocument({ mimeType: 'application/msword', ext: 'doc' });
      pdfs.failOn('officeToPdf');

      await run();

      const document = stateOf();
      expect(document.steps.preview).toBe('FAILED');
      // The reported cause stays the conversion failure rather than being overwritten by its
      // consequence — "no canonical PDF" tells an admin nothing they can act on.
      expect(document.failedStep).toBe('canonical');
      expect(document.processingError).toContain('officeToPdf failed');
    });

    it('keeps a rendering failure out of the canonicalization result', async () => {
      givenDocument({ mimeType: 'application/rtf', ext: 'rtf' });
      pdfs.failOn('pdfFirstPageJpg');

      await run();

      const document = stateOf();
      // 🔒 Step isolation (docs/05 §5.5): the canonical PDF was produced and stays DONE.
      expect(document.steps.canonical).toBe('DONE');
      expect(document.steps.preview).toBe('FAILED');
      expect(files.keys()).toEqual([artifactKeys.canonicalPdf(DOCUMENT_ID)]);
    });

    it('reports an image the resizer cannot read as a preview failure', async () => {
      givenDocument({ mimeType: 'image/tiff', ext: 'tiff' });
      images.failing = true;

      await run();

      expect(stateOf().steps.preview).toBe('FAILED');
      expect(stateOf().processingError).toContain('unsupported image format');
    });

    it('throws when the file is gone, so the job retries rather than settling wrongly', async () => {
      const document = documents.add(documentFixture());
      fileRefs.add({
        id: 'ref-missing',
        libraryId: LIBRARY_ID,
        documentId: document.id,
        status: 'MISSING',
      });

      await expect(run()).rejects.toThrow(/no available file/);
      expect(stateOf().steps.preview).toBe('PENDING');
    });
  });

  describe('reprocessing a subset of steps (docs/07 §7.3)', () => {
    it('runs only the requested step and leaves the others exactly as they were', async () => {
      givenDocument({ mimeType: 'application/pdf' });
      await run();
      const before = stateOf();
      files.clear();
      pdfs.calls.length = 0;

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['preview'] });

      const after = stateOf();
      expect(after.steps.preview).toBe('DONE');
      expect(files.keys()).toEqual([
        artifactKeys.preview(DOCUMENT_ID),
        artifactKeys.thumbnail(DOCUMENT_ID),
      ]);
      // Nothing else was touched: the Markdown is the one from the first run, not re-extracted.
      expect(after.markdown).toBe(before.markdown);
      expect(pdfs.markdownReads).toHaveLength(1);
      expect(analyst.calls).toHaveLength(1);
      expect(chunks.replacements).toBe(1);
    });

    it('re-reads the canonical PDF for a later step instead of converting again', async () => {
      givenDocument({ mimeType: 'application/rtf', ext: 'rtf' });
      pdfs.markdownByContent.set(
        'canonical-pdf',
        'Converted body text that is long enough to trust',
      );
      await run();
      pdfs.calls.length = 0;

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['markdown'] });

      // 🔒 The office file is not converted a second time; step 3 reads what step 1 already wrote
      // to the bucket (docs/07 §7.3).
      expect(pdfs.calls.some((call) => call.method === 'officeToPdf')).toBe(false);
      expect(stateOf().markdown).toBe('Converted body text that is long enough to trust');
      expect(stateOf().steps.canonical).toBe('DONE');
    });

    it('fails a step that depends on a canonical PDF which was never produced', async () => {
      givenDocument({ mimeType: 'application/msword', ext: 'doc' });
      pdfs.failOn('officeToPdf');
      await run();
      pdfs.failures.clear();

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['markdown'] });

      expect(stateOf().steps.markdown).toBe('FAILED');
    });

    it('settles only the requested steps of an unsupported document', async () => {
      givenDocument({ mimeType: 'application/x-executable', ext: 'bin' });

      await handler.handle({ documentId: DOCUMENT_ID, steps: ['preview'] });

      const document = stateOf();
      expect(document.steps.preview).toBe('SKIPPED');
      // Never asked for, never written.
      expect(document.steps.markdown).toBe('PENDING');
      expect(analyst.calls).toEqual([]);
    });

    it('parses through Docling when it is configured, and reads its languages back', async () => {
      givenDocument({ mimeType: 'application/pdf' });
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
      expect(parser.calls).toEqual([{ ocrLanguages: [] }]);
    });

    it("gives OCR the document's own languages once they are known", async () => {
      givenDocument({ mimeType: 'image/jpeg', ext: 'jpg', languages: ['ru', 'sr-Latn'] });
      parser.configured = true;
      parser.markdown = 'Договор / Ugovor';

      await run();

      // BCP-47 in the row, tesseract codes on the wire — `srp_latn`, not `srp`, or every diacritic
      // is lost (docs/03 §3.3.10).
      expect(parser.calls).toEqual([{ ocrLanguages: ['rus', 'srp_latn'] }]);
    });

    it('falls back to the instance languages when the document has none yet', async () => {
      givenDocument({ mimeType: 'image/jpeg', ext: 'jpg' });
      parser.configured = true;
      parser.markdown = 'x';

      await run();

      // The instance default from ProcessingSettings, exactly as configured.
      expect(parser.calls).toEqual([{ ocrLanguages: ['rus', 'eng'] }]);
    });

    it('says which service did a step, and ties both entries to one request id', async () => {
      givenDocument({ mimeType: 'application/pdf', ext: 'pdf' });
      parser.configured = true;

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
      givenDocument({ mimeType: 'application/pdf', ext: 'pdf' });
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

    it('rejects a step name the pipeline does not have', async () => {
      givenDocument();

      await expect(
        handler.handle({ documentId: DOCUMENT_ID, steps: ['thumbnail'] }),
      ).rejects.toThrow();
    });
  });

  describe('idempotency', () => {
    it('rewrites artifacts and statuses on a re-run without duplicating anything', async () => {
      givenDocument();

      await run();
      await run();

      expect(files.keys()).toEqual([
        artifactKeys.preview(DOCUMENT_ID),
        artifactKeys.thumbnail(DOCUMENT_ID),
      ]);
      expect(stateOf().steps.preview).toBe('DONE');
      // Twice through the same path: two renders, two pairs of resizes, one pair of objects.
      expect(pdfs.calls.filter((call) => call.method === 'pdfFirstPageJpg')).toHaveLength(2);
      expect(images.resizes).toHaveLength(4);
      expect(stateOf().steps.markdown).toBe('DONE');
    });

    it('clears an earlier failure when the re-run succeeds', async () => {
      givenDocument({ mimeType: 'application/rtf', ext: 'rtf' });
      pdfs.failOn('pdfFirstPageJpg');
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
      givenDocument({ deletedAt: new Date('2026-01-02T00:00:00.000Z') });

      await run();

      expect(documents.updates).toEqual([]);
      expect(files.keys()).toEqual([]);
    });

    it('ignores a job for a document that no longer exists', async () => {
      await expect(run(GONE_ID)).resolves.toBeUndefined();
    });
  });

  it('rejects a payload that is not a document id', async () => {
    await expect(handler.handle({ id: DOCUMENT_ID })).rejects.toThrow();
  });
});
