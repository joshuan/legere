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
  InMemoryFileRepository,
  InMemoryLibraryRepository,
  InMemorySettingsRepository,
  libraryFixture,
  queueSettingsFixture,
  StubLibraryReader,
} from '../../../../test/helpers/processing-fakes';
import type { Document } from '../../domain/entities/document';
import type { File } from '../../domain/entities/file';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { BuildCanonical } from '../documents/build-canonical';
import { artifactKeys, originalKeyOf } from '../storage/artifact-keys';
import { AnalysisSettings } from '../settings/analysis-settings';
import type { ProcessingSettings } from './processing-settings';
import { HandleDocumentProcess } from './handle-document-process';

const PREVIEW_MAX_DIM = 1600;
const THUMB_MAX_DIM = 400;
const MIN_CHARS_PER_PAGE = 32;
// Comfortably above the threshold, so the default PDF path is "has a text layer".
const TEXT_LAYER = 'Invoice 2026-01 for services rendered in January, payable within 30 days.';
const GONE_ID = '44444444-4444-4444-8444-444444444444';

// One page of a document: the file row, and the bytes behind it.
type PageSpec = { file?: Partial<File>; bytes?: string };

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
  // Mutable, so a test can say what step 4 is allowed to be shown without rebuilding the handler.
  let settings: ProcessingSettings;
  let people: InMemoryPersonRepository;
  let subjects: InMemorySubjectRepository;
  let subjectKinds: InMemorySubjectKindRepository;
  let chunks: InMemoryDocumentChunkRepository;
  let embeddings: FakeEmbeddingProvider;
  let calls: FakeCallContext;
  let handler: HandleDocumentProcess;

  beforeEach(() => {
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

    settings = {
      previewMaxDim: PREVIEW_MAX_DIM,
      thumbMaxDim: THUMB_MAX_DIM,
      ocrLanguages: ['rus', 'eng'],
      pdfTextMinCharsPerPage: MIN_CHARS_PER_PAGE,
      chunkTargetChars: 200,
      chunkOverlapChars: 40,
      analystExcerptChars: 0,
      // Off for the suite: what the analyst is shown has its own tests, and every other test here
      // counts renders and resizes that step 4 would otherwise add to.
      analystMaxPageImages: 0,
      analystPageImageMaxDim: 1200,
    };

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
      people,
      subjects,
      subjectKinds,
      chunks,
      embeddings,
      new ImmediateUnitOfWork(),
      calls,
      new AnalysisSettings(new InMemorySettingsRepository()),
      settings,
    );
  });

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
            crop: {
              points: [
                [0.1, 0.2],
                [0.9, 0.2],
                [0.9, 0.8],
                [0.1, 0.8],
              ],
            },
            cropSource: 'MANUAL',
          },
          bytes: 'photo',
        },
      ]);

      await run();

      // The perspective transform runs over the original and its result becomes the page; the file
      // itself is never rewritten (docs/03 §3.3.16).
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
      expect(document.steps).toMatchObject({
        canonical: 'SKIPPED',
        preview: 'SKIPPED',
        markdown: 'SKIPPED',
        vectorization: 'SKIPPED',
      });
      expect(document.skipReasons).toMatchObject({
        canonical: 'UNSUPPORTED_FORMAT',
        preview: 'UNSUPPORTED_FORMAT',
        markdown: 'UNSUPPORTED_FORMAT',
      });
      // A title is still something to classify, and 🔒 no step may be left PENDING — the document
      // would read as "still processing" for the rest of its life (docs/03 §3.3.10).
      expect(document.steps.analysis).toBe('DONE');
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
      expect(parser.calls).toEqual([{ ocrLanguages: [] }]);
    });

    it("gives the parser the document's own languages when it has to recognise", async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
        languages: ['ru', 'sr-Latn'],
      });
      parser.configured = true;
      parser.markdown = 'Договор / Ugovor';

      await run();

      expect(parser.calls).toEqual([{ ocrLanguages: [] }, { ocrLanguages: ['rus', 'srp_latn'] }]);
    });

    it('falls back to the instance languages when the document has none yet', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }]);
      parser.configured = true;
      parser.markdown = 'x';

      await run();

      // The instance default from ProcessingSettings, exactly as configured.
      expect(parser.calls).toEqual([{ ocrLanguages: [] }, { ocrLanguages: ['rus', 'eng'] }]);
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

    it('never overwrites a documentType a person chose', async () => {
      await givenDocument([{ file: { mimeType: 'application/pdf', ext: 'pdf' }, bytes: 'a-pdf' }], {
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
      expect(document.processingError).toContain('503');
      // The document is still readable and still gets its vectors.
      expect(document.steps.markdown).toBe('DONE');
      expect(document.steps.vectorization).toBe('DONE');
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
      chunkTargetChars: 200,
      chunkOverlapChars: 40,
        analystExcerptChars: 0,
        analystMaxPageImages: 20,
        analystPageImageMaxDim: 1200,
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
      people,
      subjects,
      subjectKinds,
      chunks,
      embeddings,
      new ImmediateUnitOfWork(),
      calls,
      new AnalysisSettings(new InMemorySettingsRepository()),
      settings,
    );
  }
});
