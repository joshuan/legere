import { describe, expect, it } from 'vitest';
import { RelativePath } from '../value-objects/relative-path';
import { canTransition, isLive, needsRehash, type FileRef } from './file-ref';

const ref = (overrides: Partial<FileRef> = {}): FileRef => ({
  id: 'ref-1',
  libraryId: 'lib-1',
  path: RelativePath.parse('a/b.pdf'),
  size: 100n,
  mtimeMs: 1_700_000_000_000,
  status: 'HASHED',
  contentHash: 'a'.repeat(64),
  fileId: 'file-1',
  missingSince: null,
  firstSeenAt: new Date(0),
  lastSeenAt: new Date(0),
  ...overrides,
});

describe('needsRehash (docs/05 §5.2)', () => {
  it('skips a file whose path, size and mtime all match', () => {
    expect(needsRehash(ref(), 100n, 1_700_000_000_000)).toBe(false);
  });

  it('re-hashes when the size changed', () => {
    expect(needsRehash(ref(), 101n, 1_700_000_000_000)).toBe(true);
  });

  it('re-hashes when the mtime changed, even at the same size', () => {
    expect(needsRehash(ref(), 100n, 1_700_000_060_000)).toBe(true);
  });

  it('ignores sub-millisecond mtime drift, which filesystems report inconsistently', () => {
    expect(needsRehash(ref({ mtimeMs: 1_700_000_000_000.4 }), 100n, 1_700_000_000_000.9)).toBe(
      false,
    );
  });

  it('re-hashes anything not already fully ingested', () => {
    expect(needsRehash(ref({ status: 'DISCOVERED' }), 100n, 1_700_000_000_000)).toBe(true);
    expect(needsRehash(ref({ status: 'MISSING' }), 100n, 1_700_000_000_000)).toBe(true);
    // HASHED but never attached to a file — an interrupted ingest.
    expect(needsRehash(ref({ contentHash: null }), 100n, 1_700_000_000_000)).toBe(true);
    expect(needsRehash(ref({ fileId: null }), 100n, 1_700_000_000_000)).toBe(true);
  });

  // 🔒 The regression the whole of §3.3.9 exists to prevent: an excluded ref points at no file, so
  // every rule above would say "re-hash" — and re-hashing it is how a document an admin deleted
  // would be back within fifteen minutes, its original still lying on a volume we may not write to.
  it('leaves an excluded path alone while its bytes are unchanged', () => {
    const excluded = ref({ status: 'EXCLUDED', fileId: null });

    expect(needsRehash(excluded, 100n, 1_700_000_000_000)).toBe(false);
    // Different bytes at that path are not what was deleted, so they are read like anything new.
    expect(needsRehash(excluded, 101n, 1_700_000_000_000)).toBe(true);
    expect(needsRehash(excluded, 100n, 1_700_000_060_000)).toBe(true);
  });
});

describe('canTransition (docs/03 §3.3.9)', () => {
  it('allows the documented moves', () => {
    expect(canTransition('DISCOVERED', 'HASHED')).toBe(true);
    expect(canTransition('HASHED', 'MISSING')).toBe(true);
    expect(canTransition('MISSING', 'HASHED')).toBe(true);
    expect(canTransition('MISSING', 'DISCOVERED')).toBe(true);
    // Size/mtime moved, so the ref goes back for a re-hash.
    expect(canTransition('HASHED', 'DISCOVERED')).toBe(true);
  });

  it('treats staying put as allowed', () => {
    expect(canTransition('HASHED', 'HASHED')).toBe(true);
  });

  it('lets a deletion exclude a ref whatever it was doing, and lets only new bytes undo it', () => {
    expect(canTransition('HASHED', 'EXCLUDED')).toBe(true);
    expect(canTransition('MISSING', 'EXCLUDED')).toBe(true);
    expect(canTransition('DISCOVERED', 'EXCLUDED')).toBe(true);

    expect(canTransition('EXCLUDED', 'DISCOVERED')).toBe(true);
    // And live again without being re-read, when the file is restored from the trash: the hash on
    // the ref is what matched it, so there is nothing left to find out (docs/05 §5.7a).
    expect(canTransition('EXCLUDED', 'HASHED')).toBe(true);
    // Never "missing", though: that would be news about a document that no longer exists.
    expect(canTransition('EXCLUDED', 'MISSING')).toBe(false);
  });
});

describe('isLive', () => {
  it('is true only for a hashed ref attached to a file', () => {
    expect(isLive(ref())).toBe(true);
    expect(isLive(ref({ status: 'MISSING' }))).toBe(false);
    expect(isLive(ref({ status: 'DISCOVERED' }))).toBe(false);
    expect(isLive(ref({ fileId: null }))).toBe(false);
  });
});
