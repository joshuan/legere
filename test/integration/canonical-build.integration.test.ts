import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import type { Crop } from '../../src/shared/contracts/documents';
import { BuildCanonical } from '../../src/server/application/documents/build-canonical';
import { QueueSettings, ungatedServices } from '../../src/server/application/queue/queue-settings';
import { ServiceGates } from '../../src/server/application/queue/service-gate';
import { originalKeyOf } from '../../src/server/application/storage/artifact-keys';
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

// Step 1 of the pipeline end to end (docs/05 §5.5, ADR-021): a photograph, a PDF and an office file
// are three files of one document, and what comes out is a single PDF in position order. The real
// Stirling container, the real sharp, the real repositories — the only double here is the bucket.
describe('Building the canonical PDF (integration, Stirling-PDF)', () => {
  let prisma: PrismaService;
  let storage: InMemoryFileStorage;
  let build: BuildCanonical;
  let close: () => Promise<void>;

  beforeAll(async () => {
    stirling.up = await reachable(`${STIRLING_URL}/api/v1/info/status`);

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
    storage = new InMemoryFileStorage();

    build = new BuildCanonical(
      moduleRef.get(FileRepository),
      moduleRef.get(FileRefRepository),
      moduleRef.get(LibraryRepository),
      // Every file here is managed, so the volume is never opened; a reader is still required.
      new StubLibraryReader(),
      storage,
      new SharpImageTool(),
      new StirlingPdfToolbox(config, new ServiceGates()),
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

  // One managed file at the given position, with its bytes in the bucket.
  async function givenFile(
    documentId: string,
    position: number,
    input: { name: string; ext: string; mimeType: string; bytes: Buffer; crop?: Crop },
  ): Promise<void> {
    const crop = input.crop;
    const file = await prisma.file.create({
      data: {
        contentHash: `${position}`.repeat(64).slice(0, 64),
        origin: 'MANAGED',
        mimeType: input.mimeType,
        ext: input.ext,
        sizeBytes: BigInt(input.bytes.byteLength),
        name: input.name,
        ...(crop === undefined
          ? {}
          : {
              crop: { points: crop.points.map(([x, y]) => [x, y]) },
              cropSource: 'MANUAL' as const,
            }),
      },
    });
    await prisma.file.update({
      where: { id: file.id },
      data: { storageKey: `files/${file.id}/original.${input.ext}` },
    });
    await prisma.documentFile.create({ data: { documentId, position, fileId: file.id } });
    await storage.put(
      originalKeyOf({ id: file.id, ext: input.ext, storageKey: null }),
      input.bytes,
      input.mimeType,
    );
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
      const pdfs = new StirlingPdfToolbox(config, new ServiceGates());
      const text = await pdfs.pdfToMarkdown(built.pdf);
      expect(text).toContain(PDF_TEXT.slice(0, 40));
      expect(text).toContain(OFFICE_TEXT.slice(0, 40));
      expect(text.indexOf(PDF_TEXT.slice(0, 40))).toBeLessThan(
        text.indexOf(OFFICE_TEXT.slice(0, 40)),
      );
    },
  );

  // The pages inside one file (docs/05 §5.5 step 1.1). A three-page PDF scanned in the wrong order
  // becomes a canonical whose pages read first to last — and the file it was built from is byte for
  // byte what it was.
  itWithStirling('reads a shuffled PDF in the order the file records', async () => {
    const document = await prisma.document.create({ data: { title: 'Out of order' } });
    // As the scanner left it: the pages of the paper are 1, 2, 3 and they arrived 3, 1, 2.
    const scan = pdfWithText([
      'THIRD page of the paper',
      'FIRST page of the paper',
      'SECOND page of the paper',
    ]);
    await givenFile(document.id, 0, {
      name: 'scan.pdf',
      ext: 'pdf',
      mimeType: 'application/pdf',
      bytes: scan,
    });
    const file = await prisma.file.findFirstOrThrow({ where: { name: 'scan.pdf' } });
    // What a person dragged into place: page 2 of the file first, then 3, then 1.
    await prisma.file.update({ where: { id: file.id }, data: { pageOrder: [1, 2, 0] } });

    const built = await build.execute({ ...documentRow(document.id), title: 'Out of order' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    expect(built.pageCount).toBe(3);

    const pdfs = new StirlingPdfToolbox(config, new ServiceGates());
    const text = await pdfs.pdfToMarkdown(built.pdf);
    expect(text.indexOf('FIRST page')).toBeGreaterThanOrEqual(0);
    // The paper, read the way the paper reads.
    expect(text.indexOf('FIRST page')).toBeLessThan(text.indexOf('SECOND page'));
    expect(text.indexOf('SECOND page')).toBeLessThan(text.indexOf('THIRD page'));

    // 🔒 Not a byte of the original was rewritten: a page order is an instruction the build reads,
    // never an edit to the file (docs/03 §3.3.16, ADR-007).
    expect(storage.get(originalKeyOf({ id: file.id, ext: 'pdf', storageKey: null })).body).toEqual(
      scan,
    );
    // And the build counted the file's pages on its way past, which is what an edit checks an order
    // against (docs/03 §3.3.16).
    const counted = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(counted.pageCount).toBe(3);
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
    const file = await prisma.file.findFirstOrThrow({ where: { name: 'restored.pdf' } });
    await prisma.file.update({ where: { id: file.id }, data: { pageOrder: [1, 2, 0] } });
    await build.execute({ ...documentRow(document.id), title: 'Put back' });

    // Clearing costs nothing to say, because nothing was ever changed (docs/05 §5.6).
    await prisma.file.update({ where: { id: file.id }, data: { pageOrder: Prisma.DbNull } });
    const built = await build.execute({ ...documentRow(document.id), title: 'Put back' });

    if (built.kind !== 'built') throw new Error('the canonical was not built');
    const pdfs = new StirlingPdfToolbox(config, new ServiceGates());
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

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
