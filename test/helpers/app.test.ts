import { describe, expect, it } from 'vitest';
import { tokenFromFragmentUrl } from './app';

describe('tokenFromFragmentUrl', () => {
  it('reads an encoded secret only from the URL fragment', () => {
    expect(tokenFromFragmentUrl('https://legere.local/invite#token=a%2Fb%3Dc')).toBe('a/b=c');
  });

  it.each([
    'https://legere.local/invite/legacy-path-token',
    'https://legere.local/invite',
    'https://legere.local/invite#token=',
  ])('rejects a URL without a fragment token: %s', (url) => {
    expect(() => tokenFromFragmentUrl(url)).toThrow(`No token in ${url}`);
  });
});
