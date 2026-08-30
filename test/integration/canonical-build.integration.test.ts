import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import type { Crop } from '../../src/shared/contracts/documents';
import { BuildCanonical } from '../../src/server/application/documents/build-canonical';
import { QueueSettings, ungatedServices } from '../../src/server/application/queue/queue-settings';
import { ServiceGates } from '../../src/server/application/queue/service-gate';
import { FixedClock } from '../helpers/fakes';
import { originalKeyOf } from '../../src/server/application/storage/artifact-keys';
import {
  pagesForFile,
  withFileCrop,
  withFilePageOrder,
  withFilePageTurns,
  withInsertedAt,
  type PageEntry,
} from '../../src/server/domain/entities/document-page';
import { FileRepository } from '../../src/server/domain/repositories/file.repository';
import { FileRefRepository } from '../../src/server/domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../src/server/domain/repositories/library.repository';
import { SettingsRepository } from '../../src/server/domain/repositories/settings.repository';
import { loadConfig } from '../../src/server/infrastructure/config/app-config';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { SharpImageTool } from '../../src/server/infrastructure/pdf/sharp-image-tool';
import { StirlingPdfToolbox } from '../../src/server/infrastructure/pdf/stirling-pdf-toolbox';
import { InMemoryFileStorage } from '../../src/server/infrastructure/storage/in-memory-file-storage';
import { rtfWithText } from '../fixtures/office';
import { pdfWithText } from '../fixtures/pdf';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';
import { StubLibraryReader } from '../helpers/processing-fakes';

const config = loadConfig(process.env);
const STIRLING_URL = config.get('STIRLING_URL');

// Needs the Stirling container from `npm run dev:up` (ADR-012). CI runs no sibling containers, so
// each test skips itself when nothing answers rather than failing the build (docs/14 §14.8).
const stirling = { up: false };

function itWithStirling(name: string, body: () => Promise<void>, timeoutMs = 120_000): void {
  it(
    name,
    async (ctx: TestContext) => {
      if (!stirling.up) ctx.skip(`no Stirling on ${STIRLING_URL} — run \`npm run dev:up\``);
      await body();
    },
    timeoutMs,
  );
}

const PDF_TEXT =
  'The first part of this document is an ordinary PDF and it carries a whole sentence of its own.';
const OFFICE_TEXT =
  'The third part started life as an office file and was converted on its way into the canonical.';

// The five pages of the contract a photograph is put into the middle of, and the twelve of the lease
// a split cuts in two. Each page names itself in a token no other page of either fixture contains,
// short enough to sit inside the sheet the fixture draws it on — so "which page is this" and "is
// this page here at all" are questions the built bytes answer rather than the calls that made them.
const CONTRACT_PAGES = [
  'C01 the first page of the contract',
  'C02 the second page of the contract',
  'C03 the third page of the contract',
  'C04 the fourth page of the contract',
  'C05 the fifth page of the contract',
];
const LEASE_PAGES = Array.from(
  { length: 12 },
  (unused, index) => `P${String(index + 1).padStart(2, '0')} a page of the lease agreement`,
);
// Where the lease is cut: eight pages stay behind and four go, which is the scan whose ninth page
// begins another contract (docs/05 §5.6).
const CUT_AT = 8;

// Step 1 of the pipeline end to end (docs/05 §5.5, ADR-021): a photograph, a PDF and an office file
// are three files of one document, and what comes out is a single PDF in position order. The real
// Stirling container, the real sharp, the real repositories — the only double here is the bucket.
describe('Building the canonical PDF (integration, Stirling-PDF)', () => {
  let prisma: PrismaService;
  let files: FileRepository;
  let storage: InMemoryFileStorage;
  let build: BuildCanonical;
  let close: () => Promise<void>;

  beforeAll(async () => {
    stirling.up = await reachable(`${STIRLING_URL}/api/v1/info/status`);

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    files = moduleRef.get(FileRepository);
    close = () => moduleRef.close();
    storage = new InMemoryFileStorage();

    build = new BuildCanonical(
      moduleRef.get(FileRepository),
      moduleRef.get(FileRefRepository),
      moduleRef.get(LibraryRepository),
      // Every file here is managed, so the volume is never opened; a reader is still required.
      new StubLibraryReader(),
      storage,
      new SharpImageTool(new PinoLogger({ pinoHttp: { level: 'silent' } })),
      new StirlingPdfToolbox(config, new ServiceGates(new FixedClock())),
      new QueueSettings(moduleRef.get(SettingsRepository), {
        concurrency: {
          'library-scan': 1,
          'file-ingest': 1,
          'document-process': 1,
          maintenance: 1,
        },
        unitConcurrency: 2,
        services: ungatedServices(),
      }),
      {
        previewMaxDim: 1600,
        thumbMaxDim: 400,
        ocrLanguages: ['eng'],
        // The text of two of the three pages is well over this, so the assembled document is judged
        // to carry its own text and the (slow) OCR pass stays out of this test.
        pdfTextMinCharsPerPage: 20,
        correctImagePages: true,
        chunkTargetChars: 200,
        chunkOverlapChars: 40,
        analystExcerptChars: 0,
        analystMaxPageImages: 20,
        analystPageImageMaxDim: 1200,
        analystAutoMaxPages: 0,
        transcriberMaxPages: 0,
        transcriberPageImageMaxDim: 1600,
      },
    );

    await truncateAll();
  });

  beforeEach(async () => {
    await truncateAll();
    storage.clear();
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  // One managed file whose pages are appended to the document, with its bytes in the bucket. A file
  // `pages` says the count of is held as its own pages, exactly as a file a build has already
  // counted; anything else is one entry standing for it whole, which the first build expands
  // (docs/03 §3.3.17). `at` puts them at a position in the list instead of after it — the entries
  // `POST …/files` writes when a file is dropped between two pages (docs/05 §5.6, ADR-025).
  async function givenFile(
    documentId: string,
    position: number,
    input: {
      name: string;
      ext: string;
      mimeType: string;
      bytes: Buffer;
      crop?: Crop;
      pages?: number;
      at?: number;
    },
  ): Promise<string> {
    const file = await prisma.file.create({
      data: {
        contentHash: `${position}`.repeat(64).slice(0, 64),
        origin: 'MANAGED',
        mimeType: input.mimeType,
        ext: input.ext,
        sizeBytes: BigInt(input.bytes.byteLength),
        name: input.name,
        ...(input.pages === undefined ? {} : { pageCount: input.pages }),
      },
    });
    await prisma.file.update({
      where: { id: file.id },
      data: { storageKey: `files/${file.id}/original.${input.ext}` },
    });
    const at = input.at;
    if (at === undefined) {
      await files.appendPages(documentId, pagesForFile(file));
    } else {
      await rewrite(documentId, (pages) =>
        withInsertedAt(pages, at, pagesForFile({ id: file.id, pageCount: input.pages ?? null })),
      );
    }
    const crop = input.crop;
    if (crop !== undefined) {
      await rewrite(documentId, (pages) => withFileCrop(pages, file.id, crop, 'MANUAL'));
    }
    await storage.put(
      originalKeyOf({ id: file.id, ext: input.ext, storageKey: null }),
      input.bytes,
      input.mimeType,
    );
    return file.id;
  }

  // What every composition edit does: read the list, answer with the list it should be, write it
  // back (docs/03 §3.3.17).
  async function rewrite(
    documentId: string,
    edit: (pages: PageEntry[]) => PageEntry[],
  ): Promise<void> {
    const held = await files.listPagesForDocument(documentId);
    await files.replacePages(documentId, { pages: edit(held), expecting: null });
  }

  itWithStirling(
    'assembles an image, a PDF and an office file into one canonical PDF',
    async () => {
      const document = await prisma.document.create({ data: { title: 'Everything at once' } });

      // A photograph of a page, cropped the way a person would drag the corners (docs/05 §5.6).
      await givenFile(document.id, 0, {
        name: 'photo.jpg',
        ext: 'jpg',
        mimeType: 'image/jpeg',
        bytes: await photograph(),
        crop: {
          points: [
            [0.1, 0.1],
            [0.9, 0.15],
            [0.9, 0.9],
            [0.1, 0.85],
          ],
        },
      });
      await givenFile(document.id, 1, {
        name: 'contract.pdf',
        ext: 'pdf',
        mimeType: 'application/pdf',
        bytes: pdfWithText([PDF_TEXT]),
      });
      await givenFile(document.id, 2, {
        name: 'appendix.rtf',
        ext: 'rtf',
        mimeType: 'application/rtf',
        bytes: rtfWithText(OFFICE_TEXT),
      });

      const built = await build.execute({
        ...documentRow(document.id),
        title: 'Everything at once',
      });

      if (built.kind !== 'built') throw new Error('the canonical was not built');
      expect(built.pdf.subarray(0, 5).toString()).toBe('%PDF-');
      // Three files, three pages, in position order (docs/05 §5.5 step 1).
      expect(built.pageCount).toBe(3);
      expect(built.unsupported).toBe(0);
      // Two of the three pages carry real text, so the document is not sent to OCR.
      expect(built.ocrUsed).toBe(false);

      // The parts are in the order the document holds them, and the text of both readable ones
      // survived the merge.
      const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
      const text = await pdfs.pdfToMarkdown(built.pdf);
      expect(text).toContain(PDF_TEXT.slice(0, 40));
      expect(text).toContain(OFFICE_TEXT.slice(0, 40));
      expect(text.indexOf(PDF_TEXT.slice(0, 40))).toBeLessThan(
        text.indexOf(OFFICE_TEXT.slice(0, 40)),
      );
    },
  );

  // The pages of one file (docs/05 §5.5 step 1). A three-page PDF scanned in the wrong order
  // becomes a canonical whose pages read first to last — and the file it was built from is byte for
  // byte what it was.
  itWithStirling('reads a shuffled PDF in the order the document holds its pages', async () => {
    const document = await prisma.document.create({ data: { title: 'Out of order' } });
    // As the scanner left it: the pages of the paper are 1, 2, 3 and they arrived 3, 1, 2.
    const scan = pdfWithText([
      'THIRD page of the paper',
      'FIRST page of the paper',
      'SECOND page of the paper',
    ]);
    const fileId = await givenFile(document.id, 0, {
      name: 'scan.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
      bytes: scan,
      pages: 3,
    });
    // What a person dragged into place: page 2 of the file first, then 3, then 1.
    await rewrite(document.id, (pages) => withFilePageOrder(pages, fileId, [1, 2, 0]));

    const built = await build.execute({ ...documentRow(document.id), title: 'Out of order' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    expect(built.pageCount).toBe(3);

    const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
    const text = await pdfs.pdfToMarkdown(built.pdf);
    expect(text.indexOf('FIRST page')).toBeGreaterThanOrEqual(0);
    // The paper, read the way the paper reads.
    expect(text.indexOf('FIRST page')).toBeLessThan(text.indexOf('SECOND page'));
    expect(text.indexOf('SECOND page')).toBeLessThan(text.indexOf('THIRD page'));

    // 🔒 Not a byte of the original was rewritten: the order of the pages is the document's own
    // list, never an edit to the file (docs/03 §3.3.17, ADR-007).
    expect(storage.get(originalKeyOf({ id: fileId, ext: 'pdf', storageKey: null })).body).toEqual(
      scan,
    );
    // And the build counted the file's pages on its way past, which is what an edit checks a page
    // index against (docs/03 §3.3.16).
    const counted = await prisma.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(counted.pageCount).toBe(3);
  });

  // 🔒 The whole of what "a document is pages" buys, on real bytes (M55.3, ADR-025). M55.3 could
  // only watch the composed order go past `rearrangePages` and `mergePdfs` with a fake toolbox;
  // this reads the canonical Stirling actually gave back, page by page, and asks where each page
  // stands.
  itWithStirling(
    'holds a photograph inserted between two pages of a PDF exactly where it was put',
    async () => {
      const document = await prisma.document.create({ data: { title: 'A page in the middle' } });
      await givenFile(document.id, 0, {
        name: 'contract.pdf',
        ext: 'pdf',
        mimeType: 'application/pdf',
        bytes: pdfWithText(CONTRACT_PAGES),
        pages: 5,
      });
      // Between page two and page three, which is the gesture the whole milestone exists for. The
      // photograph arrives uncounted, as an upload does, so the entry stands for the file whole and
      // this build is also the one that expands it — in the middle of the list (docs/05 §5.5 step 1.1).
      await givenFile(document.id, 1, {
        name: 'annex.jpg',
        ext: 'jpg',
        mimeType: 'image/jpeg',
        bytes: await landscapePhotograph(),
        at: 2,
      });

      const built = await build.execute({
        ...documentRow(document.id),
        title: 'A page in the middle',
      });

      if (built.kind !== 'built') throw new Error('the canonical was not built');
      const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
      // Six pages, counted off the finished artifact rather than off the parts that went into it.
      expect(await pdfs.pdfPageCount(built.pdf)).toBe(6);
      expect(built.pageCount).toBe(6);
      expect(built.unsupported).toBe(0);
      // The five text pages are well over the threshold, so what is read below is the pages' own
      // text and not a recognizer's guess at it.
      expect(built.ocrUsed).toBe(false);

      // The composed order, page by page: the contract's first two pages, then the photograph —
      // which carries no text at all — then the contract's remaining three.
      const texts = await pageTextsOf(pdfs, built.pdf, 6);
      expect(texts[0]).toContain('C01');
      expect(texts[1]).toContain('C02');
      expect(texts[2]?.trim()).toBe('');
      expect(texts[3]).toContain('C03');
      expect(texts[4]).toContain('C04');
      expect(texts[5]).toContain('C05');
      // And no page of the contract wandered onto the page the photograph took.
      for (const [index, text] of texts.entries()) {
        for (const [page, marker] of ['C01', 'C02', 'C03', 'C04', 'C05'].entries()) {
          const expected = page < 2 ? page : page + 1;
          if (index !== expected) expect(text).not.toContain(marker);
        }
      }

      // The textless page is the photograph and not a blank the merge left behind: it is the one
      // page of the six lying on its side, because a page is built in the shape of what it was made
      // from (docs/05 §5.5 step 1).
      const middle = await shapeOf(pdfs, built.pdf, 3);
      expect(middle.width).toBeGreaterThan(middle.height);
      const before = await shapeOf(pdfs, built.pdf, 2);
      expect(before.height).toBeGreaterThan(before.width);
    },
    180_000,
  );

  // 🔒 A split on real bytes (M55.4, ADR-025): the entries divide between two documents over the
  // *same* file, nothing is extracted and nothing is copied — so the only honest proof that each
  // half is its own paper is the two canonicals, read for what they hold and for what they do not.
  itWithStirling(
    'gives each half of a split its own pages of the one file and none of the other half’s',
    async () => {
      const document = await prisma.document.create({ data: { title: 'The whole lease' } });
      const lease = pdfWithText(LEASE_PAGES);
      const fileId = await givenFile(document.id, 0, {
        name: 'lease.pdf',
        ext: 'pdf',
        mimeType: 'application/pdf',
        bytes: lease,
        pages: 12,
      });

      // What `SplitDocumentAtPages` writes: the list divides at the boundary, the far half is
      // written afresh in a document of its own — a page id addresses an entry inside the document
      // that holds it — and every entry goes on naming the file it always named.
      const held = await files.listPagesForDocument(document.id);
      const far = await prisma.document.create({ data: { title: 'The rest of the lease' } });
      await files.replacePages(far.id, {
        pages: held.slice(CUT_AT).map(asNewEntry),
        expecting: null,
      });
      await files.replacePages(document.id, { pages: held.slice(0, CUT_AT), expecting: null });

      const near = await build.execute({
        ...documentRow(document.id),
        title: 'The whole lease',
      });
      const rest = await build.execute({ ...documentRow(far.id), title: 'The rest of the lease' });

      if (near.kind !== 'built') throw new Error('the near half was not built');
      if (rest.kind !== 'built') throw new Error('the far half was not built');
      const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
      // Eight pages and four, counted off the two finished artifacts.
      expect(await pdfs.pdfPageCount(near.pdf)).toBe(CUT_AT);
      expect(await pdfs.pdfPageCount(rest.pdf)).toBe(LEASE_PAGES.length - CUT_AT);
      expect(near.pageCount).toBe(CUT_AT);
      expect(rest.pageCount).toBe(LEASE_PAGES.length - CUT_AT);
      expect(near.ocrUsed).toBe(false);
      expect(rest.ocrUsed).toBe(false);

      // Each half holds its own pages, in the order the paper reads them…
      const nearText = await pdfs.pdfToMarkdown(near.pdf);
      const restText = await pdfs.pdfToMarkdown(rest.pdf);
      expectMarkersInOrder(nearText, markersOf(0, CUT_AT));
      expectMarkersInOrder(restText, markersOf(CUT_AT, LEASE_PAGES.length));
      // …and not one page of the other's.
      for (const marker of markersOf(CUT_AT, LEASE_PAGES.length)) {
        expect(nearText).not.toContain(marker);
      }
      for (const marker of markersOf(0, CUT_AT)) {
        expect(restText).not.toContain(marker);
      }

      // 🔒 One file, read by pages in two places: no bytes copied, no file extracted, the original
      // byte for byte what it was (docs/05 §5.6, ADR-007).
      expect(storage.get(originalKeyOf({ id: fileId, ext: 'pdf', storageKey: null })).body).toEqual(
        lease,
      );
      expect(await files.filterFilesWithoutLivePages([fileId])).toEqual([]);
    },
    240_000,
  );

  // Which way up the paper lay (docs/05 §5.5 step 1). One page of a scan lying sideways is stood
  // up in the canonical while the other two are left exactly as they are — and the file the build
  // read is byte for byte what it was.
  itWithStirling('stands one page of a scan upright without touching the file', async () => {
    const document = await prisma.document.create({ data: { title: 'Sideways' } });
    const scan = pdfWithText(['UPRIGHT one', 'SIDEWAYS two', 'UPRIGHT three']);
    const fileId = await givenFile(document.id, 0, {
      name: 'sideways.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
      bytes: scan,
      pages: 3,
    });
    // A build has to have counted the pages before an edit could store this; here the file arrives
    // counted and the turn is written on the page it belongs to, which is the same state it lands in.
    await rewrite(document.id, (pages) => withFilePageTurns(pages, fileId, [0, 1, 0]));

    const built = await build.execute({ ...documentRow(document.id), title: 'Sideways' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    expect(built.pageCount).toBe(3);

    const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
    // The page that was turned is landscape in the canonical; the two beside it are not.
    const shapes = await Promise.all(
      [1, 2, 3].map(async (page) => {
        const jpeg = await pdfs.pdfPageJpg(built.pdf, { page, dpi: 50 });
        const meta = await sharp(jpeg).metadata();
        return { width: meta.width ?? 0, height: meta.height ?? 0 };
      }),
    );
    expect(shapes[1]?.width).toBeGreaterThan(shapes[1]?.height ?? 0);
    expect(shapes[0]?.height).toBeGreaterThan(shapes[0]?.width ?? 0);
    expect(shapes[2]?.height).toBeGreaterThan(shapes[2]?.width ?? 0);

    // 🔒 Not a byte of the original was rewritten: a turn is an instruction the build reads, never
    // an edit to the file (docs/03 §3.3.17, ADR-007).
    expect(storage.get(originalKeyOf({ id: fileId, ext: 'pdf', storageKey: null })).body).toEqual(
      scan,
    );
  });

  itWithStirling('rebuilds to the pages as they arrived once the turn is cleared', async () => {
    const document = await prisma.document.create({ data: { title: 'Stood back down' } });
    const fileId = await givenFile(document.id, 0, {
      name: 'turned.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
      bytes: pdfWithText(['One', 'Two']),
      pages: 2,
    });
    await rewrite(document.id, (pages) => withFilePageTurns(pages, fileId, [1, 1]));
    await build.execute({ ...documentRow(document.id), title: 'Stood back down' });

    // Clearing costs nothing to say, because nothing was ever changed (docs/05 §5.6).
    await rewrite(document.id, (pages) => withFilePageTurns(pages, fileId, null));
    const built = await build.execute({ ...documentRow(document.id), title: 'Stood back down' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
    const jpeg = await pdfs.pdfPageJpg(built.pdf, { page: 1, dpi: 50 });
    const meta = await sharp(jpeg).metadata();
    expect(meta.height ?? 0).toBeGreaterThan(meta.width ?? 0);
  });

  itWithStirling('rebuilds to the pages as they arrived once the order is cleared', async () => {
    const document = await prisma.document.create({ data: { title: 'Put back' } });
    await givenFile(document.id, 0, {
      name: 'restored.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
      bytes: pdfWithText([
        'THIRD page of the paper',
        'FIRST page of the paper',
        'SECOND page of the paper',
      ]),
    });
    await build.execute({ ...documentRow(document.id), title: 'Put back' });
    const restored = await prisma.file.findFirstOrThrow({ where: { name: 'restored.pdf' } });
    await rewrite(document.id, (pages) => withFilePageOrder(pages, restored.id, [1, 2, 0]));
    await build.execute({ ...documentRow(document.id), title: 'Put back' });

    // Clearing costs nothing to say, because nothing was ever changed (docs/05 §5.6).
    await rewrite(document.id, (pages) => withFilePageOrder(pages, restored.id, null));
    const built = await build.execute({ ...documentRow(document.id), title: 'Put back' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    const pdfs = new StirlingPdfToolbox(config, new ServiceGates(new FixedClock()));
    const text = await pdfs.pdfToMarkdown(built.pdf);
    // The scanner's own order is back, whole and unaltered.
    expect(text.indexOf('THIRD page')).toBeLessThan(text.indexOf('FIRST page'));
    expect(text.indexOf('FIRST page')).toBeLessThan(text.indexOf('SECOND page'));
  });

  itWithStirling('leaves out a file nothing can render and says so', async () => {
    const document = await prisma.document.create({ data: { title: 'One good page' } });
    await givenFile(document.id, 0, {
      name: 'contract.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
      bytes: pdfWithText([PDF_TEXT]),
    });
    await givenFile(document.id, 1, {
      name: 'firmware.bin',
      ext: 'bin',
      mimeType: 'application/x-executable',
      bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]),
    });

    const built = await build.execute({ ...documentRow(document.id), title: 'One good page' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    // The document is what could be built, and the missing page is recorded rather than fatal.
    expect(built.pageCount).toBe(1);
    expect(built.unsupported).toBe(1);
  });

  itWithStirling('builds nothing at all for a document nothing can render', async () => {
    const document = await prisma.document.create({ data: { title: 'Only firmware' } });
    await givenFile(document.id, 0, {
      name: 'firmware.bin',
      ext: 'bin',
      mimeType: 'application/x-executable',
      bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]),
    });

    const built = await build.execute({ ...documentRow(document.id), title: 'Only firmware' });

    expect(built).toEqual({ kind: 'nothingToBuild', unsupported: 1 });
  });
});

// The fields BuildCanonical reads off the row; everything else about a document is somebody else's
// business (docs/05 §5.5 step 1).
function documentRow(id: string) {
  return {
    id,
    pageCount: null,
    title: 'Document',
    description: null,
    pageFormat: 'AUTO' as const,
    titleSource: 'NONE' as const,
    markdown: null,
    steps: {
      canonical: 'PENDING' as const,
      preview: 'PENDING' as const,
      markdown: 'PENDING' as const,
      analysis: 'PENDING' as const,
      fields: 'PENDING' as const,
      vectorization: 'PENDING' as const,
    },
    processingError: null,
    skipReasons: {},
    languages: [],
    auto: {},
    documentDate: null,
    country: null,
    city: null,
    failedStep: null,
    ocrUsed: false,
    typeId: null,
    typeSource: 'NONE' as const,
    extracted: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastEventAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
  };
}

// The text of a built PDF, one page at a time. Taking each page out on its own is what makes the
// answer say *where* a page stands rather than merely that its words are somewhere in the file —
// which is the only question a composed order asks (docs/05 §5.5 step 1). One page at a time and in
// order, because this reads a document that is already built and not a container under load.
async function pageTextsOf(
  toolbox: StirlingPdfToolbox,
  pdf: Buffer,
  pageCount: number,
): Promise<string[]> {
  const texts: string[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    texts.push(await toolbox.pdfToMarkdown(await toolbox.rearrangePages(pdf, [page])));
  }
  return texts;
}

// The shape one page presents, read off a render of it: which way up a page lies is a fact about the
// picture it makes, and nothing shorter than rendering it says so honestly (docs/05 §5.5).
async function shapeOf(
  toolbox: StirlingPdfToolbox,
  pdf: Buffer,
  page: number,
): Promise<{ width: number; height: number }> {
  const meta = await sharp(await toolbox.pdfPageJpg(pdf, { page, dpi: 50 })).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

// The tokens the lease's pages `from`…`to` name themselves by, in the order the paper reads them.
function markersOf(from: number, to: number): string[] {
  return LEASE_PAGES.slice(from, to).map((page) => page.slice(0, 3));
}

function expectMarkersInOrder(text: string, markers: readonly string[]): void {
  const at = markers.map((marker) => text.indexOf(marker));
  for (const [index, position] of at.entries()) {
    expect(position, `${markers[index] ?? ''} is missing`).toBeGreaterThanOrEqual(0);
    if (index > 0) expect(position).toBeGreaterThan(at[index - 1] ?? -1);
  }
}

// An entry joining another document is a new entry there: nothing addresses a page across documents,
// and a row carries the document it belongs to (docs/03 §3.3.17). This is what a split does to the
// half that leaves.
function asNewEntry(page: PageEntry): PageEntry {
  return {
    fileId: page.fileId,
    pageIndex: page.pageIndex,
    turn: page.turn,
    crop: page.crop,
    cropSource: page.cropSource,
  };
}

// A page photographed on a dark table: light rectangle, dark border, which is what the crop cuts.
function photograph(): Promise<Buffer> {
  return sharp({ create: { width: 800, height: 1000, channels: 3, background: '#202020' } })
    .composite([
      {
        input: {
          create: { width: 600, height: 800, channels: 3, background: '#f4f4f4' },
        },
        left: 100,
        top: 100,
      },
    ])
    .jpeg()
    .toBuffer();
}

// The photograph that goes between page two and page three: a sheet lying the other way up, so the
// page it becomes is the one landscape page of an otherwise portrait document and can be told apart
// from its neighbours by its shape alone. Its proportion is deliberately no sheet's — 8:5, well
// outside the ±8% of √2 of `document-page-geometry` — so `AUTO` leaves every page as it was built
// and the shape stays the evidence it is meant to be (docs/05 §5.5 step 1).
function landscapePhotograph(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 750, channels: 3, background: '#202020' } })
    .composite([
      {
        input: { create: { width: 1000, height: 600, channels: 3, background: '#f4f4f4' } },
        left: 100,
        top: 75,
      },
    ])
    .jpeg()
    .toBuffer();
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
