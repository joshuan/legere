import { describe, expect, it } from 'vitest';
import { classifyFormat } from './document-format';

// The routing decision of docs/05 §5.5 step 1, made once and consulted by every step after it.
describe('classifyFormat', () => {
  it('recognizes a PDF', () => {
    expect(classifyFormat('application/pdf')).toBe('PDF');
  });

  it('recognizes the office formats Stirling converts', () => {
    for (const mime of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
      'application/vnd.oasis.opendocument.text',
    ]) {
      expect(classifyFormat(mime)).toBe('OFFICE');
    }
  });

  it('treats RTF and HTML as office documents, not as text', () => {
    // Both are text on the wire; reading them raw would put markup into the search index.
    expect(classifyFormat('text/rtf')).toBe('OFFICE');
    expect(classifyFormat('text/html')).toBe('OFFICE');
  });

  it('recognizes images the tooling can open', () => {
    expect(classifyFormat('image/jpeg')).toBe('IMAGE');
    expect(classifyFormat('image/png')).toBe('IMAGE');
    expect(classifyFormat('image/tiff')).toBe('IMAGE');
    // Markup rather than pixels — a document library has no use for rasterizing it.
    expect(classifyFormat('image/svg+xml')).toBe('UNSUPPORTED');
  });

  it('recognizes readable text', () => {
    expect(classifyFormat('text/plain')).toBe('TEXT');
    expect(classifyFormat('text/markdown')).toBe('TEXT');
    expect(classifyFormat('text/csv')).toBe('TEXT');
    expect(classifyFormat('application/json')).toBe('TEXT');
    // Anything else under text/ is still text to the Markdown step.
    expect(classifyFormat('text/x-log')).toBe('TEXT');
  });

  it('ignores parameters and case, which arrive from real detectors', () => {
    expect(classifyFormat('APPLICATION/PDF')).toBe('PDF');
    expect(classifyFormat('text/plain; charset=utf-8')).toBe('TEXT');
  });

  it('calls everything else unsupported rather than guessing', () => {
    expect(classifyFormat('application/octet-stream')).toBe('UNSUPPORTED');
    expect(classifyFormat('application/x-executable')).toBe('UNSUPPORTED');
    expect(classifyFormat('video/mp4')).toBe('UNSUPPORTED');
    expect(classifyFormat('')).toBe('UNSUPPORTED');
  });
});
