import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { FakePdfToolbox } from '../../../../test/helpers/processing-fakes';
import { InMemoryFileStorage } from '../storage/in-memory-file-storage';
import { StirlingOcrRenderer } from './stirling-ocr-renderer';

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();

describe('Stirling OCR raster limits', () => {
  it('renders the captured PDF key and page at 300 DPI, retaining byte identity', async () => {
    const files = new InMemoryFileStorage();
    await files.put('saved-revision.pdf', Buffer.from('pdf'), 'application/pdf');
    const pdfs = new FakePdfToolbox();
    const bytes = await png(100, 200);
    const render = vi.spyOn(pdfs, 'pdfPagePng').mockResolvedValue(bytes);
    const result = await new StirlingOcrRenderer(files, pdfs).render('saved-revision.pdf', 4);
    expect(render).toHaveBeenCalledWith(expect.anything(), { page: 4, dpi: 300 });
    expect(result).toEqual({
      bytes,
      width: 100,
      height: 200,
      dpi: 300,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  it('reduces raster resolution until the common provider pixel limit is met', async () => {
    const files = new InMemoryFileStorage();
    await files.put('large.pdf', Buffer.from('pdf'), 'application/pdf');
    const pdfs = new FakePdfToolbox();
    const oversized = await png(5000, 4100);
    const render = vi
      .spyOn(pdfs, 'pdfPagePng')
      .mockResolvedValueOnce(oversized)
      .mockResolvedValue(await png(3300, 2700));
    expect((await new StirlingOcrRenderer(files, pdfs).render('large.pdf', 1)).dpi).toBe(200);
    expect(render).toHaveBeenCalledTimes(2);
    render.mockResolvedValue(oversized);
    await expect(new StirlingOcrRenderer(files, pdfs).render('large.pdf', 1)).rejects.toThrow(
      'even at 72 DPI',
    );
  });
});
