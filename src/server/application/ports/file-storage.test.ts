import { describe, expect, it } from 'vitest';
import { safeDownloadFileName } from './file-storage';

describe('safeDownloadFileName', () => {
  it('keeps a normal Unicode title and its requested extension', () => {
    expect(safeDownloadFileName('Счёт за январь', '.pdf')).toBe('Счёт за январь.pdf');
  });

  it('removes controls, bidi marks and filesystem-reserved characters', () => {
    expect(safeDownloadFileName(' report/2026:\u202Eevil\n ', 'pdf')).toBe('report_2026_evil.pdf');
  });

  it('falls back for a title that becomes empty and caps UTF-8 bytes', () => {
    expect(safeDownloadFileName(' .\u0000 ', '.pdf')).toBe('document.pdf');
    expect(
      Buffer.byteLength(safeDownloadFileName('я'.repeat(500), '.pdf'), 'utf8'),
    ).toBeLessThanOrEqual(240);
  });
});
