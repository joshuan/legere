import { beforeAll, describe, expect, it } from 'vitest';
import { ServiceGates } from '../../src/server/application/queue/service-gate';
import { loadConfig } from '../../src/server/infrastructure/config/app-config';
import { DoclingParser } from '../../src/server/infrastructure/pdf/docling-parser';
import { wordFixture } from '../fixtures/office';
import { pdfWithText } from '../fixtures/pdf';
import { FixedClock } from '../helpers/fakes';

const config = loadConfig(process.env);
const endpoint = config.get('DOCLING_URL');
let available = false;

// Exercise the shipped local engine through the real submit/poll/result API. CI without a
// Docling service skips these; parser-image maintenance runs them against the candidate image.
describe('DoclingParser (integration, local engine)', () => {
  const parser = new DoclingParser(config, new ServiceGates(new FixedClock()));

  beforeAll(async () => {
    if (endpoint === '') return;
    available = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false);
  });

  it('reads both pages of a PDF with the Tesseract OCR path enabled', async (ctx) => {
    if (!available) ctx.skip('Docling is not available');
    const markdown = await parser.toMarkdown(
      pdfWithText(['FIRSTPAGE archive record', 'SECONDPAGE archive record']),
      { pageCount: 2, ocrLanguages: ['eng'] },
    );
    expect(markdown).toContain('FIRSTPAGE');
    expect(markdown).toContain('SECONDPAGE');
    expect(markdown.indexOf('FIRSTPAGE')).toBeLessThan(markdown.indexOf('SECONDPAGE'));
  }, 180_000);

  it('reads DOCX directly without the optional cluster runtime', async (ctx) => {
    if (!available) ctx.skip('Docling is not available');
    const markdown = await parser.toMarkdown(await wordFixture('docx'), {
      format: 'docx',
      pageCount: 0,
      ocrLanguages: [],
    });
    expect(markdown).toContain('FIRSTPAGE');
    expect(markdown).toContain('SECONDPAGE');
  }, 60_000);
});
