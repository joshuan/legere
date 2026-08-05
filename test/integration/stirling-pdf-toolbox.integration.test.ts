import sharp from 'sharp';
import { beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { loadConfig } from '../../src/server/infrastructure/config/app-config';
import { StirlingPdfToolbox } from '../../src/server/infrastructure/pdf/stirling-pdf-toolbox';
import { rtfWithText } from '../fixtures/office';
import { pdfWithText } from '../fixtures/pdf';

const config = loadConfig(process.env);
const STIRLING_URL = config.get('STIRLING_URL');

// Needs the Stirling container from `npm run dev:up` (ADR-012). CI runs no sibling containers, so
// each test skips itself when nothing answers rather than failing the build (docs/14 §14.8).
const stirling = { up: false };

function itWithStirling(name: string, body: () => Promise<void>, timeoutMs = 60_000): void {
  it(
    name,
    async (ctx: TestContext) => {
      if (!stirling.up) ctx.skip(`no Stirling on ${STIRLING_URL} — run \`npm run dev:up\``);
      await body();
    },
    timeoutMs,
  );
}

describe('StirlingPdfToolbox (integration, Stirling-PDF)', () => {
  const pdfs = new StirlingPdfToolbox(config);

  beforeAll(async () => {
    stirling.up = await reachable(`${STIRLING_URL}/api/v1/info/status`);
  });

  itWithStirling('counts the pages of a PDF', async () => {
    expect(await pdfs.pdfPageCount(pdfWithText(['one', 'two', 'three']))).toBe(3);
  });

  itWithStirling(
    'converts an office document to a PDF that still holds its text',
    async () => {
      const pdf = await pdfs.toPdf({
        body: rtfWithText('Quarterly report for Legere'),
        fileName: 'report.rtf',
      });

      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      // Converted, not merely wrapped: the text survives into the canonical PDF and step 3 can read
      // it without OCR (docs/05 §5.5).
      expect(await pdfs.pdfToMarkdown(pdf)).toContain('Quarterly report for Legere');
    },
    120_000,
  );

  itWithStirling('renders the first page as a JPEG', async () => {
    const jpeg = await pdfs.pdfFirstPageJpg(pdfWithText(['Front page', 'Back page']));
    const meta = await sharp(jpeg).metadata();

    expect(meta.format).toBe('jpeg');
    // US Letter at 150 dpi, portrait — the page proportions come through.
    expect(meta.width).toBeGreaterThan(1000);
    expect(meta.height).toBeGreaterThan(meta.width ?? 0);
  });

  itWithStirling('renders at the requested resolution', async () => {
    const [low, high] = await Promise.all([
      pdfs.pdfFirstPageJpg(pdfWithText(['Page']), { dpi: 72 }),
      pdfs.pdfFirstPageJpg(pdfWithText(['Page']), { dpi: 200 }),
    ]);

    const [lowMeta, highMeta] = await Promise.all([sharp(low).metadata(), sharp(high).metadata()]);
    expect(highMeta.width ?? 0).toBeGreaterThan(lowMeta.width ?? 0);
  });

  itWithStirling('merges images into one PDF, a page per image in order', async () => {
    const images = [
      { body: await colorImage('#ff8800', 600, 400), fileName: 'first.jpg' },
      { body: await colorImage('#0088ff', 500, 700), fileName: 'second.jpg' },
    ];

    const merged = await pdfs.imagesToPdf(images);

    expect(merged.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pdfs.pdfPageCount(merged)).toBe(2);
  });

  itWithStirling('merges the parts of a document into one PDF, in the order given', async () => {
    // What step 1 does with a document of several files (docs/05 §5.5 step 1).
    const merged = await pdfs.mergePdfs([
      pdfWithText(['First part, page one', 'First part, page two']),
      pdfWithText(['Second part']),
    ]);

    expect(await pdfs.pdfPageCount(merged)).toBe(3);
    const text = await pdfs.pdfToMarkdown(merged);
    expect(text.indexOf('First part, page one')).toBeLessThan(text.indexOf('Second part'));
  });

  itWithStirling('stamps the title and the date into the metadata', async () => {
    const stamped = await pdfs.stampMetadata(pdfWithText(['A page']), {
      title: 'Lease agreement',
      date: new Date('2019-07-14T08:30:00.000Z'),
    });

    expect(stamped.subarray(0, 5).toString()).toBe('%PDF-');
    // The PDF still reads: metadata is written beside the pages, never instead of them. The title
    // itself lands in a compressed object stream, so what is checked here is that the container
    // accepted the fields and gave back a document — a wrong date format is a 500, not a silent no-op.
    expect(await pdfs.pdfPageCount(stamped)).toBe(1);
  });

  itWithStirling(
    'OCRs a scan into a PDF whose text can then be read',
    async () => {
      // A page with no text layer at all — exactly what step 3 sends to OCR.
      const scan = await pdfs.imagesToPdf([
        { body: await renderedText('LEGERE OCR'), fileName: 'scan.jpg' },
      ]);
      expect((await pdfs.pdfToMarkdown(scan)).trim()).toBe('');

      const searchable = await pdfs.ocrPdf(scan, ['eng']);

      expect(await pdfs.pdfToMarkdown(searchable)).toContain('LEGERE OCR');
    },
    180_000,
  );

  itWithStirling('reports what the container said when a file is not a PDF at all', async () => {
    // The failure a job actually hits: a file that reached the PDF path but is not one.
    await expect(pdfs.pdfPageCount(Buffer.from('not really a PDF'))).rejects.toThrow(
      /Stirling .*failed with \d{3}/,
    );
  });
});

function colorImage(background: string, width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();
}

// Rasterized text, the way a scanner produces it. Rendering goes through librsvg, which needs a font
// on the host — the suite is local-only, and a machine with no fonts at all would fail here.
function renderedText(value: string): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="300">` +
      `<rect width="1000" height="300" fill="white"/>` +
      `<text x="40" y="200" font-family="Helvetica, Arial, sans-serif" font-size="120" fill="black">${value}</text>` +
      `</svg>`,
  );
  return sharp(svg).jpeg({ quality: 95 }).toBuffer();
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
