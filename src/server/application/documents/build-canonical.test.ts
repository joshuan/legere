import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeImageTool,
  FakePdfToolbox,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  InMemoryLibraryRepository,
  InMemorySettingsRepository,
  StubLibraryReader,
  documentFixture,
} from '../../../../test/helpers/processing-fakes';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import type { File as FileEntity } from '../../domain/entities/file';
import { QueueSettings, ungatedServices } from '../queue/queue-settings';
import { BuildCanonical } from './build-canonical';

// A page is built in the shape of what it was made from, recognised there, and only then given its
// format (docs/05 §5.5 step 1). The order is the whole point: a page that is half white margin is a
// page the recognizer reads as blank, and the text it produces is vector, so it survives being
// scaled afterwards. These are the tests that would have caught the archive going quietly
// unsearchable.

const A4_LANDSCAPE = { width: 2810, height: 1987 };
const A4_PORTRAIT = { width: 2480, height: 3508 };
const RECEIPT = { width: 900, height: 2600 };

const SETTINGS = {
  previewMaxDim: 1600,
  thumbMaxDim: 400,
  ocrLanguages: ['rus', 'eng'],
  // Everything the fake toolbox reads back is shorter than this, so every document here is judged
  // to be a scan and takes the OCR branch — which is the branch that matters.
  pdfTextMinCharsPerPage: 10_000,
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

describe('BuildCanonical: the shape of a page and when it is decided', () => {
  let files: InMemoryFileRepository;
  let pdfs: FakePdfToolbox;
  let images: FakeImageTool;
  let storage: InMemoryFileStorage;
  let build: BuildCanonical;

  beforeEach(() => {
    files = new InMemoryFileRepository();
    pdfs = new FakePdfToolbox();
    images = new FakeImageTool();
    storage = new InMemoryFileStorage();
    build = new BuildCanonical(
      files,
      new InMemoryFileRefRepository(),
      new InMemoryLibraryRepository(),
      new StubLibraryReader(),
      storage,
      images,
      pdfs,
      new QueueSettings(new InMemorySettingsRepository(), {
        concurrency: {
          'library-scan': 1,
          'file-ingest': 1,
          'document-process': 1,
          maintenance: 1,
        },
        unitConcurrency: 1,
        services: ungatedServices(),
      }),
      SETTINGS,
    );
  });

  const givenPhotograph = async (
    documentId: string,
    overrides: Partial<Pick<FileEntity, 'crop' | 'rotation'>> = {},
  ): Promise<void> => {
    const { file } = await files.findOrCreateByContentHash({
      contentHash: `hash-${documentId}`,
      origin: 'MANAGED',
      storageKey: `documents/${documentId}/source.jpg`,
      mimeType: 'image/jpeg',
      ext: 'jpg',
      sizeBytes: 1n,
      name: 'page.jpg',
    });
    const stored = files.files.get(file.id);
    if (stored !== undefined) files.files.set(file.id, { ...stored, ...overrides });
    await files.attach(documentId, file.id);
    // The bytes a managed file points at. Their content does not matter here — the fakes describe
    // rather than decode — but the object has to be there for the page to be opened at all.
    await storage.put(
      `documents/${documentId}/source.jpg`,
      Buffer.from('photograph'),
      'image/jpeg',
    );
  };

  const methods = (): string[] => pdfs.calls.map((call) => call.method);

  it('gives a landscape photograph of a sheet an A4 laid the same way', async () => {
    images.size = A4_LANDSCAPE;
    const document = documentFixture();
    await givenPhotograph(document.id);

    const built = await build.execute(document);

    expect(built.kind).toBe('built');
    expect(pdfs.calls).toContainEqual({ method: 'scalePages', fileName: 'A4:LANDSCAPE' });
  });

  it('stands a portrait one up', async () => {
    images.size = A4_PORTRAIT;
    const document = documentFixture();
    await givenPhotograph(document.id);

    await build.execute(document);

    expect(pdfs.calls).toContainEqual({ method: 'scalePages', fileName: 'A4:PORTRAIT' });
  });

  it('recognises before it normalises, never the other way round', async () => {
    images.size = A4_LANDSCAPE;
    const document = documentFixture();
    await givenPhotograph(document.id);

    await build.execute(document);

    const order = methods();
    expect(order).toContain('ocrPdf');
    expect(order).toContain('scalePages');
    // 🔒 The assertion this whole task exists for. Scaled first, the page carries white margins into
    // the recognizer and comes back empty — measured on a real document as zero characters against
    // six hundred and forty-nine.
    expect(order.indexOf('ocrPdf')).toBeLessThan(order.indexOf('scalePages'));
  });

  it('leaves a receipt the shape it was photographed in', async () => {
    images.size = RECEIPT;
    const document = documentFixture();
    await givenPhotograph(document.id);

    await build.execute(document);

    expect(methods()).not.toContain('scalePages');
  });

  it('obeys a person who asked for A4 over a shape that is not one', async () => {
    images.size = RECEIPT;
    const document = documentFixture({ pageFormat: 'A4' });
    await givenPhotograph(document.id);

    await build.execute(document);

    expect(pdfs.calls).toContainEqual({ method: 'scalePages', fileName: 'A4:PORTRAIT' });
  });

  // The pages inside one file (docs/05 §5.5 step 1.1). A PDF part is counted every build and read in
  // the order the file records — and the file itself is never opened for writing, here or anywhere.
  describe('the pages of one file', () => {
    const givenPdf = async (
      documentId: string,
      pageOrder: number[] | null = null,
      pageRotations: FileEntity['pageRotations'] = null,
    ): Promise<string> => {
      const key = `files/pdf-${documentId}/original.pdf`;
      const file = files.add(
        {
          id: `pdf-${documentId}`,
          contentHash: `pdf-${documentId}`,
          origin: 'MANAGED',
          storageKey: key,
          mimeType: 'application/pdf',
          ext: 'pdf',
          name: 'scan.pdf',
          pageOrder,
          pageRotations,
        },
        documentId,
      );
      await storage.put(key, Buffer.from('scan'), 'application/pdf');
      return file.id;
    };

    it('counts the pages of the PDF it reads and writes the number on the file', async () => {
      pdfs.pageCount = 7;
      const document = documentFixture();
      const fileId = await givenPdf(document.id);

      await build.execute(document);

      // The one moment anything opens the file, so the one moment its page count can be known —
      // and what an edit checks a page order against later (docs/03 §3.3.16).
      expect(files.files.get(fileId)?.pageCount).toBe(7);
    });

    it('puts the pages into the stored order before the merge, without touching the file', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      const fileId = await givenPdf(document.id, [2, 0, 1]);

      await build.execute(document);

      expect(pdfs.calls).toContainEqual({ method: 'rearrangePages', fileName: '2,0,1' });
      // 🔒 The object the file's bytes live in is exactly what was put there: the rearranged PDF is
      // the part, and the original stays the original (docs/03 §3.3.16, ADR-007).
      expect(storage.get(`files/pdf-${document.id}/original.pdf`).body.toString()).toBe('scan');
      expect(files.files.get(fileId)?.pageOrder).toEqual([2, 0, 1]);
    });

    it('asks for nothing when the pages already stand as they should', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, [0, 1, 2]);

      await build.execute(document);

      // The natural order spelled out is still the natural order, and not worth a call.
      expect(methods()).not.toContain('rearrangePages');
    });

    it('ignores an order that does not describe the pages it just counted', async () => {
      pdfs.pageCount = 2;
      const document = documentFixture();
      const fileId = await givenPdf(document.id, [2, 0, 1]);

      const built = await build.execute(document);

      // The document outranks the correction: the pages stand as they arrived, exactly as an
      // unreadable crop leaves the whole image in place (docs/05 §5.5 step 1.1).
      expect(built.kind).toBe('built');
      expect(methods()).not.toContain('rearrangePages');
      expect(files.files.get(fileId)?.pageCount).toBe(2);
    });

    it('stands the pages that lie sideways up, before the merge and without touching the file', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, null, [0, 1, 0]);

      await build.execute(document);

      expect(pdfs.calls).toContainEqual({ method: 'rotatePages', fileName: '0,1,0' });
      // 🔒 The object the file's bytes live in is exactly what was put there (ADR-007).
      expect(storage.get(`files/pdf-${document.id}/original.pdf`).body.toString()).toBe('scan');
    });

    it('turns the pages before it puts them in order, so one index means one thing', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, [2, 0, 1], [0, 1, 0]);

      await build.execute(document);

      const order = methods();
      // Both name the pages by the index they arrived under (docs/05 §5.5 step 1.1), and the turn
      // is what the rearrange is then handed: the second call carries the first one's answer.
      expect(order.indexOf('rotatePages')).toBeLessThan(order.indexOf('rearrangePages'));
      expect(pdfs.calls).toContainEqual({ method: 'rotatePages', fileName: '0,1,0' });
      expect(pdfs.calls).toContainEqual({ method: 'rearrangePages', fileName: '2,0,1' });
    });

    it('asks for nothing when every page already stands the way it should', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, null, [0, 0, 0]);

      await build.execute(document);

      expect(methods()).not.toContain('rotatePages');
    });

    it('ignores a list of turns that does not describe the pages it just counted', async () => {
      pdfs.pageCount = 2;
      const document = documentFixture();
      await givenPdf(document.id, null, [0, 1, 0]);

      const built = await build.execute(document);

      expect(built.kind).toBe('built');
      expect(methods()).not.toContain('rotatePages');
    });
  });

  // Which way up the picture lay (docs/05 §5.5 step 1): after the crop, before the correction, and
  // never a change to the bytes the file is made of.
  describe('the way up one picture lies', () => {
    it('turns the page after cropping it, so the stored quadrilateral still means what it meant', async () => {
      const document = documentFixture();
      await givenPhotograph(document.id, {
        crop: {
          points: [
            [0.1, 0.1],
            [0.9, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
          ],
        },
        rotation: { quarterTurns: 1, mirrored: false },
      });

      await build.execute(document);

      // 🔒 The turn was handed the *cropped* page, not the original: the crop is in the pixels that
      // arrived, and turning first would leave every corner somebody dragged pointing elsewhere.
      expect(images.crops).toHaveLength(1);
      expect(images.rotations).toHaveLength(1);
      expect(images.rotations.at(0)?.input).toBe('cropped(0.1,0.1):photograph');
      expect(images.rotations.at(0)?.rotation).toEqual({ quarterTurns: 1, mirrored: false });
    });

    it('gives the correction a page that is already standing up', async () => {
      images.correction = 'applied';
      const document = documentFixture();
      await givenPhotograph(document.id, { rotation: { quarterTurns: 3, mirrored: true } });

      await build.execute(document);

      // The deskew reads the rows of a page, and on a sheet still lying sideways there are none to
      // read (docs/05 §5.5 step 1).
      expect(images.corrections).toEqual(['turned(3m):photograph']);
    });

    it('measures the shape of the page after the turn, because that is what the page will be', async () => {
      const document = documentFixture();
      await givenPhotograph(document.id, { rotation: { quarterTurns: 1, mirrored: false } });

      await build.execute(document);

      // A portrait photograph lying on its side is a landscape page, and the format of the canonical
      // is read off the pages it was made from (docs/05 §5.5 step 1).
      expect(images.measured).toEqual(['turned(1):photograph']);
    });

    it('leaves an untouched picture its own bytes', async () => {
      const document = documentFixture();
      await givenPhotograph(document.id);

      await build.execute(document);

      // A turn of nothing is not worth re-encoding a page for (docs/05 §5.5 step 1).
      expect(images.rotations).toHaveLength(0);
      expect(images.measured).toEqual(['photograph']);
    });
  });

  it('keeps the canonical when the format cannot be applied', async () => {
    images.size = A4_PORTRAIT;
    pdfs.failures.add('scalePages');
    const document = documentFixture();
    await givenPhotograph(document.id);

    const built = await build.execute(document);

    // A document whose pages could not be resized is still the document; losing a finished canonical
    // over the shape of its sheet would be a poor trade (docs/05 §5.5 step 1).
    expect(built.kind).toBe('built');
  });
});
