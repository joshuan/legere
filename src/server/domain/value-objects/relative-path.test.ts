import { describe, expect, it } from 'vitest';
import { RelativePath, RelativePathError } from './relative-path';

describe('RelativePath traversal guard (🔒 docs/05 §5.1)', () => {
  it('rejects upward traversal in any position', () => {
    for (const bad of [
      '..',
      '../etc/passwd',
      'a/../../etc/passwd',
      'a/b/..',
      './../secret',
      'a/../b',
      'nested/deep/../../../outside',
    ]) {
      expect(() => RelativePath.parse(bad), bad).toThrow(RelativePathError);
      expect(RelativePath.tryParse(bad), bad).toBeNull();
    }
  });

  it('rejects absolute paths, including Windows and UNC forms', () => {
    for (const bad of ['/etc/passwd', '/', 'C:/Windows', 'c:\\Windows', '\\\\server\\share']) {
      expect(() => RelativePath.parse(bad), bad).toThrow(RelativePathError);
    }
  });

  it('rejects NUL bytes, which can truncate a path at the syscall boundary', () => {
    expect(() => RelativePath.parse('a\0b')).toThrow(RelativePathError);
  });

  it('does not mistake a name that merely starts with dots for traversal', () => {
    expect(RelativePath.parse('..hidden/file.pdf').value).toBe('..hidden/file.pdf');
    expect(RelativePath.parse('a/...b/c.txt').value).toBe('a/...b/c.txt');
  });
});

describe('RelativePath normalization', () => {
  it('collapses redundant separators and current-directory segments', () => {
    expect(RelativePath.parse('a//b/./c.pdf').value).toBe('a/b/c.pdf');
    expect(RelativePath.parse('./a/b').value).toBe('a/b');
    expect(RelativePath.parse('a/b/').value).toBe('a/b');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(RelativePath.parse('a\\b\\c.pdf').value).toBe('a/b/c.pdf');
  });

  it('treats an empty string and "." as the root', () => {
    expect(RelativePath.parse('').isRoot).toBe(true);
    expect(RelativePath.parse('.').isRoot).toBe(true);
    expect(RelativePath.root().value).toBe('');
  });
});

describe('RelativePath accessors', () => {
  it('exposes segments, name, parent', () => {
    const path = RelativePath.parse('invoices/2026/march/bill.pdf');

    expect(path.segments).toEqual(['invoices', '2026', 'march', 'bill.pdf']);
    expect(path.name).toBe('bill.pdf');
    expect(path.parent.value).toBe('invoices/2026/march');
    expect(RelativePath.parse('top.pdf').parent.isRoot).toBe(true);
    expect(RelativePath.root().parent.isRoot).toBe(true);
  });

  it('derives extension and stem, treating a leading dot as hidden rather than an extension', () => {
    expect(RelativePath.parse('a/bill.PDF').extension).toBe('pdf');
    expect(RelativePath.parse('a/bill.PDF').stem).toBe('bill');
    expect(RelativePath.parse('a/archive.tar.gz').extension).toBe('gz');
    expect(RelativePath.parse('a/README').extension).toBe('');
    expect(RelativePath.parse('a/README').stem).toBe('README');
    expect(RelativePath.parse('a/.env').extension).toBe('');
    expect(RelativePath.parse('a/.env').stem).toBe('.env');
  });

  it('re-validates on join, so a child cannot escape its parent', () => {
    const base = RelativePath.parse('invoices');

    expect(base.join('2026', 'bill.pdf').value).toBe('invoices/2026/bill.pdf');
    expect(RelativePath.root().join('bill.pdf').value).toBe('bill.pdf');
    expect(() => base.join('..')).toThrow(RelativePathError);
    expect(() => base.join('../../etc')).toThrow(RelativePathError);
  });

  it('compares by value', () => {
    expect(RelativePath.parse('a/b').equals(RelativePath.parse('a//b'))).toBe(true);
    expect(RelativePath.parse('a/b').equals(RelativePath.parse('a/c'))).toBe(false);
    expect(String(RelativePath.parse('a/b'))).toBe('a/b');
  });
});
