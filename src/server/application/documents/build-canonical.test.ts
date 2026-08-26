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
import {
  withFileCrop,
  withFilePageOrder,
  withFilePageTurns,
  withFileTurn,
  type PageEntry,
} from '../../domain/entities/document-page';
import type { Crop, Rotation } from '../../../shared/contracts/documents';
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

  // What a page of a document says about itself lives on the entry, not on the file (ADR-025), so a
  // test says it by rewriting the list the way every composition edit does.
  const editPages = async (
    documentId: string,
    edit: (pages: PageEntry[]) => PageEntry[],
  ): Promise<void> => {
    const held = await files.listPagesForDocument(documentId);
    await files.replacePages(documentId, edit(held));
  };

  const givenPhotograph = async (
    documentId: string,
    overrides: { crop?: Crop; turn?: Rotation } = {},
  ): Promise<string> => {
    const { file } = await files.findOrCreateByContentHash({
      contentHash: `hash-${documentId}`,
      origin: 'MANAGED',
      storageKey: `documents/${documentId}/source.jpg`,
      mimeType: 'image/jpeg',
      ext: 'jpg',
      sizeBytes: 1n,
      name: 'page.jpg',
    });
    await files.attach(documentId, file.id);
    if (overrides.crop !== undefined) {
      await editPages(documentId, (pages) =>
        withFileCrop(pages, file.id, overrides.crop ?? null, 'MANUAL'),
      );
    }
    if (overrides.turn !== undefined) {
      await editPages(documentId, (pages) => withFileTurn(pages, file.id, overrides.turn ?? null));
    }
    // The bytes a managed file points at. Their content does not matter here — the fakes describe
    // rather than decode — but the object has to be there for the page to be opened at all.
    await storage.put(
      `documents/${documentId}/source.jpg`,
      Buffer.from('photograph'),
      'image/jpeg',
    );
    return file.id;
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

  // The pages of one file (docs/05 §5.5 step 1). A PDF part is counted every build and read in
  // the order the file records — and the file itself is never opened for writing, here or anywhere.
  describe('the pages of one file', () => {
    // A scan somebody has already built once: its pages are counted, so the document names them one
    // by one and an order or a turn is a statement about those entries (docs/03 §3.3.17).
    const givenPdf = async (
      documentId: string,
      options: { pageCount?: number | null; order?: number[] | null; turns?: number[] | null } = {},
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
          pageCount: options.pageCount === undefined ? pdfs.pageCount : options.pageCount,
        },
        documentId,
      );
      const turns = options.turns;
      if (turns !== undefined) {
        await editPages(documentId, (pages) => withFilePageTurns(pages, file.id, turns));
      }
      const order = options.order;
      if (order !== undefined) {
        await editPages(documentId, (pages) => withFilePageOrder(pages, file.id, order));
      }
      await storage.put(key, Buffer.from('scan'), 'application/pdf');
      return file.id;
    };

    it('counts the pages of the PDF it reads and writes the number on the file', async () => {
      pdfs.pageCount = 7;
      const document = documentFixture();
      const fileId = await givenPdf(document.id, { pageCount: null });

      await build.execute(document);

      // The one moment anything opens the file, so the one moment its page count can be known —
      // and what an edit checks a page order against later (docs/03 §3.3.16).
      expect(files.files.get(fileId)?.pageCount).toBe(7);
    });

    it('takes the pages in the order the document holds them, without touching the file', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      const fileId = await givenPdf(document.id, { order: [2, 0, 1] });

      await build.execute(document);

      expect(pdfs.calls).toContainEqual({ method: 'rearrangePages', fileName: '2,0,1' });
      // 🔒 The object the file's bytes live in is exactly what was put there: the rearranged PDF is
      // the part, and the original stays the original (docs/03 §3.3.17, ADR-007).
      expect(storage.get(`files/pdf-${document.id}/original.pdf`).body.toString()).toBe('scan');
      const held = await files.listPagesForDocument(document.id);
      expect(held.map((page) => page.pageIndex)).toEqual([2, 0, 1]);
      expect(held.every((page) => page.fileId === fileId)).toBe(true);
    });

    it('asks for nothing when the pages already stand as they should', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, { order: [0, 1, 2] });

      await build.execute(document);

      // The whole file in its own order is already the part, and not worth a call.
      expect(methods()).not.toContain('rearrangePages');
    });

    it('drops an entry naming a page the file does not hold', async () => {
      // Three entries written when the file was counted at three, and a file that now opens at two:
      // the document outranks the correction, and what is left of it still builds (docs/05 §5.5).
      pdfs.pageCount = 2;
      const document = documentFixture();
      const fileId = await givenPdf(document.id, { pageCount: 3, order: [2, 0, 1] });

      const built = await build.execute(document);

      expect(built.kind).toBe('built');
      expect(methods()).not.toContain('rearrangePages');
      expect(files.files.get(fileId)?.pageCount).toBe(2);
    });

    it('stands the pages that lie sideways up, without touching the file', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, { turns: [0, 1, 0] });

      await build.execute(document);

      expect(pdfs.calls).toContainEqual({ method: 'rotatePages', fileName: '0,1,0' });
      // 🔒 The object the file's bytes live in is exactly what was put there (ADR-007).
      expect(storage.get(`files/pdf-${document.id}/original.pdf`).body.toString()).toBe('scan');
    });

    it('picks the pages first and turns what it picked, so a turn follows its own page', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, { order: [2, 0, 1], turns: [0, 1, 0] });

      await build.execute(document);

      const order = methods();
      // Each entry names its own page and its own turn (docs/03 §3.3.17), so the selection comes
      // first and the turns are given in the order the pages were picked: page 1, the one lying
      // sideways, is read last here and its turn is the last of the three.
      expect(order.indexOf('rearrangePages')).toBeLessThan(order.indexOf('rotatePages'));
      expect(pdfs.calls).toContainEqual({ method: 'rearrangePages', fileName: '2,0,1' });
      expect(pdfs.calls).toContainEqual({ method: 'rotatePages', fileName: '0,0,1' });
    });

    it('asks for nothing when every page already stands the way it should', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      await givenPdf(document.id, { turns: [0, 0, 0] });

      await build.execute(document);

      expect(methods()).not.toContain('rotatePages');
    });

    it('expands the entry standing for a file whole once it has counted its pages', async () => {
      pdfs.pageCount = 4;
      const document = documentFixture();
      const fileId = await givenPdf(document.id, { pageCount: null });

      // Before the build the document holds one entry: this file, whole, in the order it arrived.
      expect((await files.listPagesForDocument(document.id)).map((page) => page.pageIndex)).toEqual(
        [null],
      );

      await build.execute(document);

      // 🔒 The end of the one two-level state (ADR-025): one entry per page, written down, so it
      // happens once.
      const held = await files.listPagesForDocument(document.id);
      expect(held.map((page) => page.pageIndex)).toEqual([0, 1, 2, 3]);
      expect(held.every((page) => page.fileId === fileId)).toBe(true);
      expect(held.map((page) => page.position)).toEqual([0, 1, 2, 3]);
    });

    it('renders and warps a page of a PDF somebody cropped', async () => {
      pdfs.pageCount = 3;
      const document = documentFixture();
      const fileId = await givenPdf(document.id);
      const crop: Crop = {
        points: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
      };
      await editPages(document.id, (pages) =>
        pages.map((page) =>
          page.pageIndex === 1 ? { ...page, crop, cropSource: 'MANUAL' } : page,
        ),
      );

      await build.execute(document);

      // 🔒 A scanned page is already raster and loses nothing by being rendered, and a vector page
      // cropped becomes raster — which is what somebody who dragged its corners asked for
      // (docs/03 §3.3.17). The page is asked for by its 1-based number, at the resolution the
      // recognizer reads best at.
      expect(pdfs.calls).toContainEqual({ method: 'pdfPageJpg', fileName: 'page:2@300' });
      expect(images.crops.map((one) => one.crop)).toEqual([crop]);
      // The pages either side of it are still taken out of the file rather than rendered.
      expect(pdfs.calls.filter((call) => call.method === 'pdfPageJpg')).toHaveLength(1);
      expect(files.files.get(fileId)?.pageCount).toBe(3);
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
        turn: { quarterTurns: 1, mirrored: false },
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
      await givenPhotograph(document.id, { turn: { quarterTurns: 3, mirrored: true } });

      await build.execute(document);

      // The deskew reads the rows of a page, and on a sheet still lying sideways there are none to
      // read (docs/05 §5.5 step 1).
      expect(images.corrections).toEqual(['turned(3m):photograph']);
    });

    it('measures the shape of the page after the turn, because that is what the page will be', async () => {
      const document = documentFixture();
      await givenPhotograph(document.id, { turn: { quarterTurns: 1, mirrored: false } });

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

  // What ADR-025 buys, in the smallest test that shows it: a document is a list of pages, and the
  // pages may come from anywhere.
  describe('a document made of pages rather than of files', () => {
    it('merges the pages of two files in the order the document holds them', async () => {
      pdfs.pageCount = 2;
      const document = documentFixture();
      const key = `files/scan-${document.id}/original.pdf`;
      const pdf = files.add(
        {
          id: `scan-${document.id}`,
          contentHash: `scan-${document.id}`,
          origin: 'MANAGED',
          storageKey: key,
          mimeType: 'application/pdf',
          ext: 'pdf',
          name: 'scan.pdf',
          pageCount: 2,
        },
        document.id,
      );
      await storage.put(key, Buffer.from('scan'), 'application/pdf');
      const photograph = await givenPhotograph(document.id);
      // The photograph between the two pages of the scan, which is the gesture this milestone is for.
      await editPages(document.id, (pages) => [
        pages[0] ?? { fileId: pdf.id, pageIndex: 0, turn: null, crop: null, cropSource: 'NONE' },
        pages[2] ?? {
          fileId: photograph,
          pageIndex: null,
          turn: null,
          crop: null,
          cropSource: 'NONE',
        },
        pages[1] ?? { fileId: pdf.id, pageIndex: 1, turn: null, crop: null, cropSource: 'NONE' },
      ]);

      const built = await build.execute(document);

      expect(built.kind).toBe('built');
      const merged = pdfs.calls.find((call) => call.method === 'mergePdfs');
      // Page one of the scan, the photograph, page two of the scan — three parts, in that order.
      expect(merged?.fileName).toBe(
        'rearranged(0)(scan),image-pdf(photograph),rearranged(1)(scan)',
      );
    });

    it('builds each half of a split out of its own pages of the one file', async () => {
      // What a document looks like after a cut at a page (docs/05 §5.6): two documents, one file,
      // and no bytes copied — each half holds the entries it was given and builds only those.
      pdfs.pageCount = 4;
      const first = documentFixture({ id: 'doc-kept' });
      const second = documentFixture({ id: 'doc-cut' });
      const key = 'files/two-deeds/original.pdf';
      const scan = files.add(
        {
          id: 'two-deeds',
          contentHash: 'two-deeds',
          origin: 'MANAGED',
          storageKey: key,
          mimeType: 'application/pdf',
          ext: 'pdf',
          name: 'two-deeds.pdf',
          pageCount: 4,
        },
        first.id,
      );
      await storage.put(key, Buffer.from('deeds'), 'application/pdf');
      const entry = (pageIndex: number): PageEntry => ({
        fileId: scan.id,
        pageIndex,
        turn: null,
        crop: null,
        cropSource: 'NONE',
      });
      await files.replacePages(first.id, [entry(0), entry(1)]);
      await files.replacePages(second.id, [entry(2), entry(3)]);

      const picked = (): string[] =>
        pdfs.calls.flatMap((call) =>
          call.method === 'rearrangePages' && call.fileName !== undefined ? [call.fileName] : [],
        );

      await build.execute(first);
      const kept = picked();
      await build.execute(second);
      const cut = picked().slice(kept.length);

      // 🔒 Each canonical holds its own pages, taken out of the same file by index: pages one and
      // two here, three and four there, and the file itself untouched (ADR-007).
      expect(kept).toEqual(['0,1']);
      expect(cut).toEqual(['2,3']);
      expect(files.files.size).toBe(1);
    });

    it('lets two documents crop one photograph apart', async () => {
      const first = documentFixture({ id: 'doc-first' });
      const second = documentFixture({ id: 'doc-second' });
      const fileId = await givenPhotograph(first.id);
      // The same bytes, read by a page of another document as well (ADR-025).
      await files.attach(second.id, fileId);

      const left: Crop = {
        points: [
          [0, 0],
          [0.5, 0],
          [0.5, 1],
          [0, 1],
        ],
      };
      const right: Crop = {
        points: [
          [0.5, 0],
          [1, 0],
          [1, 1],
          [0.5, 1],
        ],
      };
      await editPages(first.id, (pages) => withFileCrop(pages, fileId, left, 'MANUAL'));
      await editPages(second.id, (pages) => withFileCrop(pages, fileId, right, 'MANUAL'));

      await build.execute(first);
      await build.execute(second);

      // Each document warps the picture its own way, and neither reads the other's answer: a crop is
      // a statement about a page, not about the bytes (docs/03 §3.3.17).
      expect(images.crops.map((one) => one.crop)).toEqual([left, right]);
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
