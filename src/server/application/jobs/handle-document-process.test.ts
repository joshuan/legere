import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_ID,
  documentFixture,
  LIBRARY_ID,
  FakeImageTool,
  FakePdfToolbox,
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
const GONE_ID = '44444444-4444-4444-8444-444444444444';

// Steps 1–2 of docs/05 §5.5 with the containers and the bucket replaced by in-memory doubles: what
// is asserted here is the routing, the artifacts and the statuses — the ports themselves are covered
// by their own suites.
describe('HandleDocumentProcess', () => {
  let documents: InMemoryDocumentRepository;
  let fileRefs: InMemoryFileRefRepository;
  let libraries: InMemoryLibraryRepository;
  let reader: StubLibraryReader;
  let files: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let images: FakeImageTool;
  let handler: HandleDocumentProcess;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    fileRefs = new InMemoryFileRefRepository();
    libraries = new InMemoryLibraryRepository();
    reader = new StubLibraryReader();
    files = new InMemoryFileStorage();
    pdfs = new FakePdfToolbox();
    images = new FakeImageTool();

    libraries.add(libraryFixture());
    reader.put(SOURCE_PATH, 'source-bytes');

    handler = new HandleDocumentProcess(
      documents,
      fileRefs,
      libraries,
      reader,
      files,
      pdfs,
      images,
      { previewMaxDim: PREVIEW_MAX_DIM, thumbMaxDim: THUMB_MAX_DIM },
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

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('SKIPPED');
      expect(document.steps.preview).toBe('DONE');
      expect(document.pageCount).toBe(12);
      expect(files.keys()).toEqual([
        artifactKeys.preview(DOCUMENT_ID),
        artifactKeys.thumbnail(DOCUMENT_ID),
      ]);
      expect(pdfs.calls.map((call) => call.method)).toEqual(['pdfPageCount', 'pdfFirstPageJpg']);
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
      expect(pdfs.calls).toEqual([]);
      expect(images.resizes.map((resize) => resize.input)).toEqual([
        'source-bytes',
        'source-bytes',
      ]);
    });

    it('plain text and Markdown skip both steps', async () => {
      givenDocument({ mimeType: 'text/markdown', ext: 'md' });

      await run();

      const document = stateOf();
      expect(document.steps.canonical).toBe('SKIPPED');
      expect(document.steps.preview).toBe('SKIPPED');
      expect(files.keys()).toEqual([]);
      // Steps 3–5 are still ahead of it; nothing here settles them.
      expect(document.steps.markdown).toBe('PENDING');
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
      // A title is still something to classify, so step 4 is left alone.
      expect(document.steps.categorization).toBe('PENDING');
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
        artifactKeys.derivedSource(DERIVED_ID),
        Buffer.from('merged'),
        'application/pdf',
      );

      await run(DERIVED_ID);

      expect(stateOf(DERIVED_ID).steps.preview).toBe('DONE');
      expect(reader.opened).toEqual([]);
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
