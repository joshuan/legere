import { mkdir, mkdtemp, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LibraryLocation } from '../../src/server/application/ports/library-reader';
import { RelativePath } from '../../src/server/domain/value-objects/relative-path';
import { loadConfig } from '../../src/server/infrastructure/config/app-config';
import { FsLibraryReader } from '../../src/server/infrastructure/library/fs-library-reader';

// Integration coverage over real files (docs/14 §14.8): the walker, the exclusion rules and the
// traversal/symlink guards of docs/09 §9.1.
// chmod 000 means nothing to root: the directory stays readable, and the two tests below would fail
// for a reason that is not about the code. CI runs as an ordinary user; a root container (or a
// devcontainer) skips them instead of reporting a false failure.
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

describe('FsLibraryReader (integration)', () => {
  let root: string;
  let outside: string;
  let reader: FsLibraryReader;

  const library: LibraryLocation = { rootPath: RelativePath.root(), excludeGlobs: [] };

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'legere-lib-'));
    root = join(base, 'library');
    outside = join(base, 'outside');

    await mkdir(join(root, 'invoices', '2026'), { recursive: true });
    await mkdir(join(root, 'archive'), { recursive: true });
    await mkdir(join(root, '.hidden-dir'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(join(root, 'top.pdf'), 'top');
    await writeFile(join(root, 'invoices', 'a.pdf'), 'aa');
    await writeFile(join(root, 'invoices', '2026', 'b.pdf'), 'bbb');
    await writeFile(join(root, 'archive', 'old.txt'), 'old');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await writeFile(join(root, '.hidden-dir', 'inside.pdf'), 'hidden');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'js');
    await writeFile(join(outside, 'secret.pdf'), 'secret');

    // 🔒 A symlink pointing out of the volume must be ignored entirely (docs/14 §14.8 mandates this
    // fixture), as must one pointing inside — links are never followed.
    await symlink(join(outside, 'secret.pdf'), join(root, 'escape.pdf')).catch(() => undefined);
    await symlink(outside, join(root, 'escape-dir')).catch(() => undefined);
    await symlink(join(root, 'top.pdf'), join(root, 'alias.pdf')).catch(() => undefined);

    reader = new FsLibraryReader(
      loadConfig({
        APP_BASE_URL: 'http://localhost:3000',
        DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
        AUTH_SECRET: 'x'.repeat(32),
        LIBRARY_ROOT: root,
      }),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function walkPaths(location: LibraryLocation = library): Promise<string[]> {
    const result = reader.walk(location);
    const paths: string[] = [];
    for await (const entry of result.entries) paths.push(entry.relPath.value);
    return paths;
  }

  it('walks nested files depth-first in a deterministic, sorted order', async () => {
    const paths = await walkPaths();

    expect(paths).toEqual([
      'archive/old.txt',
      'invoices/2026/b.pdf',
      'invoices/a.pdf',
      'node_modules/pkg/index.js',
      'top.pdf',
    ]);
    // Repeating the walk over an unchanged tree yields exactly the same sequence.
    expect(await walkPaths()).toEqual(paths);
  });

  it('reports size and mtime for each entry', async () => {
    const result = reader.walk(library);
    const entries = [];
    for await (const entry of result.entries) entries.push(entry);

    const top = entries.find((entry) => entry.relPath.value === 'top.pdf');
    expect(top?.size).toBe(3n);
    expect(top?.mtimeMs).toBeGreaterThan(0);
    // BigInt, so a file larger than Number.MAX_SAFE_INTEGER stays exact (docs/04 §4.2).
    expect(typeof top?.size).toBe('bigint');
  });

  it('skips symlinks, including one escaping the volume (🔒)', async () => {
    const paths = await walkPaths();

    expect(paths).not.toContain('escape.pdf');
    expect(paths).not.toContain('alias.pdf');
    expect(paths.some((path) => path.startsWith('escape-dir'))).toBe(false);
    // The file the link points at is never reached by any means.
    expect(paths.some((path) => path.includes('secret'))).toBe(false);
    expect(await reader.stat(library, RelativePath.parse('escape.pdf'))).toBeNull();
    expect(await reader.stat(library, RelativePath.parse('alias.pdf'))).toBeNull();
  });

  it('skips hidden files and directories by default', async () => {
    const paths = await walkPaths();

    expect(paths).not.toContain('.env');
    expect(paths.some((path) => path.startsWith('.hidden-dir'))).toBe(false);
    expect(await reader.stat(library, RelativePath.parse('.env'))).toBeNull();
  });

  it('honours excludeGlobs', async () => {
    const paths = await walkPaths({
      rootPath: RelativePath.root(),
      excludeGlobs: ['**/node_modules/**', 'archive/**'],
    });

    expect(paths).toEqual(['invoices/2026/b.pdf', 'invoices/a.pdf', 'top.pdf']);
  });

  it('scopes a library to its own subdirectory', async () => {
    const paths = await walkPaths({
      rootPath: RelativePath.parse('invoices'),
      excludeGlobs: [],
    });

    // Paths are relative to the library root, not to LIBRARY_ROOT.
    expect(paths).toEqual(['2026/b.pdf', 'a.pdf']);
  });

  it('refuses to resolve a path that escapes the library root (🔒)', async () => {
    // RelativePath already blocks `..`, so the escape is attempted with a path that is valid as a
    // value but points outside once joined — the reader's own second check must catch it.
    const escaping = RelativePath.parse('invoices');
    const outsideLibrary: LibraryLocation = { rootPath: escaping, excludeGlobs: [] };

    // A library rooted at 'invoices' cannot see 'top.pdf', which lives above it.
    expect(await reader.stat(outsideLibrary, RelativePath.parse('top.pdf'))).toBeNull();
  });

  it('streams a file it can see and refuses one it cannot', async () => {
    const stream = await reader.openStream(library, RelativePath.parse('top.pdf'));
    let contents = '';
    stream.setEncoding('utf8');
    for await (const chunk of stream) contents += String(chunk);
    expect(contents).toBe('top');

    await expect(reader.openStream(library, RelativePath.parse('escape.pdf'))).rejects.toThrow();
  });

  it('lists immediate children for the directory picker, hiding links and dot-entries', async () => {
    const entries = await reader.list(library, RelativePath.root());

    expect(entries).toEqual([
      { name: 'archive', isDirectory: true },
      { name: 'invoices', isDirectory: true },
      { name: 'node_modules', isDirectory: true },
      { name: 'top.pdf', isDirectory: false },
    ]);
  });

  it('answers isDirectory for library creation', async () => {
    expect(await reader.isDirectory(RelativePath.parse('invoices'))).toBe(true);
    expect(await reader.isDirectory(RelativePath.parse('top.pdf'))).toBe(false);
    expect(await reader.isDirectory(RelativePath.parse('nope'))).toBe(false);
    expect(await reader.isDirectory(RelativePath.root())).toBe(true);
  });

  it('records an unreadable directory as an error and keeps scanning', async (ctx) => {
    if (RUNNING_AS_ROOT) ctx.skip('running as root — permission bits do not apply');
    const locked = join(root, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'file.pdf'), 'x');
    await chmod(locked, 0o000);

    try {
      const result = reader.walk(library);
      const paths: string[] = [];
      for await (const entry of result.entries) paths.push(entry.relPath.value);

      // The rest of the tree is still reported…
      expect(paths).toContain('top.pdf');
      expect(paths).toContain('invoices/a.pdf');
      // …and the failure is recorded rather than thrown.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.relPath).toBe('locked');
    } finally {
      await chmod(locked, 0o755);
      await rm(locked, { recursive: true, force: true });
    }
  });
});
