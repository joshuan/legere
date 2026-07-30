import { describe, expect, it } from 'vitest';
import { RelativePath } from '../value-objects/relative-path';
import { isLibraryVisibleTo, isScanDue, pathsOverlap, type Library } from './library';

const path = (value: string): RelativePath => RelativePath.parse(value);

describe('pathsOverlap (🔒 no nested libraries, docs/03 §3.3.6)', () => {
  it('treats identical paths as overlapping', () => {
    expect(pathsOverlap(path('invoices'), path('invoices'))).toBe(true);
    expect(pathsOverlap(RelativePath.root(), RelativePath.root())).toBe(true);
  });

  it('treats the volume root as overlapping everything', () => {
    expect(pathsOverlap(RelativePath.root(), path('invoices/2026'))).toBe(true);
    expect(pathsOverlap(path('invoices'), RelativePath.root())).toBe(true);
  });

  it('detects a descendant in either direction', () => {
    expect(pathsOverlap(path('invoices'), path('invoices/2026'))).toBe(true);
    expect(pathsOverlap(path('invoices/2026'), path('invoices'))).toBe(true);
    expect(pathsOverlap(path('a'), path('a/b/c/d'))).toBe(true);
  });

  it('allows siblings, and does not confuse a shared name prefix for nesting', () => {
    expect(pathsOverlap(path('invoices'), path('receipts'))).toBe(false);
    // 'invoices2' is a sibling of 'invoices', not a child of it.
    expect(pathsOverlap(path('invoices'), path('invoices2'))).toBe(false);
    expect(pathsOverlap(path('a/b'), path('a/c'))).toBe(false);
  });
});

describe('isLibraryVisibleTo (docs/08 §8.5)', () => {
  const library = (overrides: Partial<Library>): Library => ({
    id: 'lib-1',
    name: 'Docs',
    rootPath: path('docs'),
    enabled: true,
    visibility: 'RESTRICTED',
    scanIntervalMinutes: 15,
    excludeGlobs: [],
    createdAt: new Date(0),
    deletedAt: null,
    ...overrides,
  });

  it('shows an ALL_USERS library to everyone', () => {
    expect(isLibraryVisibleTo(library({ visibility: 'ALL_USERS' }), new Set())).toBe(true);
  });

  it('shows a RESTRICTED library only to a granted user', () => {
    expect(isLibraryVisibleTo(library({}), new Set())).toBe(false);
    expect(isLibraryVisibleTo(library({}), new Set(['lib-1']))).toBe(true);
  });

  it('hides a soft-deleted library from everyone, grant or not', () => {
    const deleted = library({ visibility: 'ALL_USERS', deletedAt: new Date() });
    expect(isLibraryVisibleTo(deleted, new Set(['lib-1']))).toBe(false);
  });

  it('keeps a disabled library visible — disabling only stops scanning', () => {
    expect(
      isLibraryVisibleTo(library({ visibility: 'ALL_USERS', enabled: false }), new Set()),
    ).toBe(true);
  });
});

describe('isScanDue (docs/03 §3.3.6, docs/05 §5.2)', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const library = { enabled: true, scanIntervalMinutes: 15, deletedAt: null };

  it('is due when it has never been scanned', () => {
    expect(isScanDue(library, null, now)).toBe(true);
  });

  it('is due once the interval has elapsed, and not before', () => {
    const justUnder = new Date(now.getTime() - 14 * 60_000 - 59_000);
    const exactly = new Date(now.getTime() - 15 * 60_000);

    expect(isScanDue(library, justUnder, now)).toBe(false);
    expect(isScanDue(library, exactly, now)).toBe(true);
    expect(isScanDue(library, new Date(now.getTime() - 60 * 60_000), now)).toBe(true);
  });

  it('honours each library’s own interval', () => {
    const hourly = { ...library, scanIntervalMinutes: 60 };
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60_000);

    expect(isScanDue(library, thirtyMinutesAgo, now)).toBe(true);
    expect(isScanDue(hourly, thirtyMinutesAgo, now)).toBe(false);
  });

  it('never scans a disabled or soft-deleted library', () => {
    expect(isScanDue({ ...library, enabled: false }, null, now)).toBe(false);
    expect(isScanDue({ ...library, deletedAt: new Date() }, null, now)).toBe(false);
  });

  it('treats a nonsensical interval as one minute rather than scanning constantly', () => {
    const zero = { ...library, scanIntervalMinutes: 0 };
    expect(isScanDue(zero, new Date(now.getTime() - 30_000), now)).toBe(false);
    expect(isScanDue(zero, new Date(now.getTime() - 61_000), now)).toBe(true);
  });
});
