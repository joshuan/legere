import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './safe-return-to';

// jsdom serves the suite from a fixed origin; everything below is judged against it.
const ORIGIN = 'http://localhost:3000';

describe('safeReturnTo', () => {
  it('runs against the origin the tests assume', () => {
    expect(window.location.origin).toBe(ORIGIN);
  });

  it('keeps a same-origin path with its query and hash', () => {
    expect(safeReturnTo('/documents/abc?tab=markdown#page-2')).toBe(
      '/documents/abc?tab=markdown#page-2',
    );
    expect(safeReturnTo('/browse/lib-1?path=%2Fscans')).toBe('/browse/lib-1?path=%2Fscans');
  });

  it('reduces a same-origin absolute URL to its path', () => {
    expect(safeReturnTo(`${ORIGIN}/documents/abc?tab=markdown#page-2`)).toBe(
      '/documents/abc?tab=markdown#page-2',
    );
  });

  it('refuses an absolute off-origin URL', () => {
    expect(safeReturnTo('https://legere-intern4l.example/login')).toBe('/documents');
    // Same host, different port and scheme: still another origin.
    expect(safeReturnTo('http://localhost:3001/documents')).toBe('/documents');
    expect(safeReturnTo('https://localhost:3000/documents')).toBe('/documents');
  });

  it('refuses a protocol-relative //host', () => {
    expect(safeReturnTo('//evil.example/x')).toBe('/documents');
    expect(safeReturnTo('///evil.example/x')).toBe('/documents');
  });

  it('refuses the backslash variants the URL parser normalizes to slashes', () => {
    expect(safeReturnTo('\\\\evil.example/x')).toBe('/documents');
    expect(safeReturnTo('/\\evil.example/x')).toBe('/documents');
    expect(safeReturnTo('\\/evil.example/x')).toBe('/documents');
    expect(safeReturnTo('https:\\\\evil.example/x')).toBe('/documents');
  });

  it('refuses javascript:, which is what makes this more than an open redirect', () => {
    // An opaque origin serializes to "null" and never equals the page's, so the scheme never
    // reaches the router.
    expect(safeReturnTo('javascript:alert(document.domain)')).toBe('/documents');
    expect(safeReturnTo('JaVaScRiPt:alert(1)')).toBe('/documents');
    expect(safeReturnTo('  javascript:alert(1)')).toBe('/documents');
    expect(safeReturnTo('data:text/html,<script>alert(1)</script>')).toBe('/documents');
  });

  it('falls back when there is no candidate at all', () => {
    expect(safeReturnTo(undefined)).toBe('/documents');
    expect(safeReturnTo(null)).toBe('/documents');
    expect(safeReturnTo('')).toBe('/documents');
  });

  it('always answers with a path on this instance', () => {
    for (const candidate of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'not a url at all',
      'documents/abc',
    ]) {
      expect(safeReturnTo(candidate).startsWith('/')).toBe(true);
    }
  });
});
