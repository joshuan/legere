import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pdfWithText } from '../../../../test/fixtures/pdf';
import { PdfjsTextExtractor } from './pdfjs-text-extractor';

const extractor = new PdfjsTextExtractor();

// This closes the pdfjs spike (M4.2): reading a text layer needs no external container, and the
// per-page split is what step 3 of docs/05 §5.5 measures against PDF_TEXT_MIN_CHARS_PER_PAGE.
describe('PdfjsTextExtractor', () => {
  it('returns the text of a single-page PDF', async () => {
    expect(await extractor.pdfTextByPage(pdfWithText(['Invoice 2026-01']))).toEqual([
      'Invoice 2026-01',
    ]);
  });

  it('keeps pages apart and in order', async () => {
    const pages = await extractor.pdfTextByPage(
      pdfWithText(['First page', 'Second page', 'Third page']),
    );

    expect(pages).toEqual(['First page', 'Second page', 'Third page']);
  });

  it('accepts a stream as readily as a buffer', async () => {
    const bytes = pdfWithText(['Streamed']);

    expect(await extractor.pdfTextByPage(Readable.from([bytes]))).toEqual(['Streamed']);
  });

  it('reports a page with no text layer as empty, which is what sends a scan to OCR', async () => {
    const pages = await extractor.pdfTextByPage(pdfWithText(['Has text', '']));

    expect(pages).toHaveLength(2);
    expect(pages[1]).toBe('');
    // The caller counts characters per page against the threshold, so an empty page must not
    // disappear from the array — the page numbering has to stay usable.
    expect(pages[0]).toBe('Has text');
  });

  it('rejects a file that is not a PDF instead of returning nothing', async () => {
    await expect(extractor.pdfTextByPage(Buffer.from('this is plain text'))).rejects.toThrow();
  });
});
