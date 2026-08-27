import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  canDestroyDocumentContent,
  canEditDocumentMeta,
  isFileReadable,
  isProcessing,
  keepsItsReaders,
  originOf,
  pendingSteps,
} from './document';

describe('isFileReadable (docs/03 §3.3.10)', () => {
  it('is true for a library file with at least one live ref', () => {
    expect(isFileReadable('LIBRARY', 1)).toBe(true);
    expect(isFileReadable('LIBRARY', 3)).toBe(true);
  });

  it('is false for a library file whose every copy has gone', () => {
    expect(isFileReadable('LIBRARY', 0)).toBe(false);
  });

  it('is always true for a managed file, whose bytes are in our own bucket', () => {
    expect(isFileReadable('MANAGED', 0)).toBe(true);
  });
});

describe('availabilityOf (docs/03 §3.3.10)', () => {
  it('is AVAILABLE only when every file of the document can be read', () => {
    expect(availabilityOf([true])).toBe('AVAILABLE');
    expect(availabilityOf([true, true, true])).toBe('AVAILABLE');
  });

  it('is PARTIAL when some files are here and some are not', () => {
    // Forty photographs of one passport, on a volume that lost half of them.
    expect(availabilityOf([true, false])).toBe('PARTIAL');
    expect(availabilityOf([false, true, false])).toBe('PARTIAL');
  });

  it('is UNAVAILABLE when none of them can be read', () => {
    expect(availabilityOf([false])).toBe('UNAVAILABLE');
    expect(availabilityOf([false, false])).toBe('UNAVAILABLE');
  });

  it('is UNAVAILABLE for a document with no files at all', () => {
    expect(availabilityOf([])).toBe('UNAVAILABLE');
  });
});

describe('originOf (docs/03 §3.3.10)', () => {
  it('is LIBRARY as soon as one file sits on a volume', () => {
    expect(originOf(['LIBRARY'])).toBe('LIBRARY');
    // A library document that absorbed an upload is still a library document.
    expect(originOf(['MANAGED', 'LIBRARY'])).toBe('LIBRARY');
  });

  it('is MANAGED when no file of the document sits on a volume', () => {
    expect(originOf(['MANAGED', 'MANAGED'])).toBe('MANAGED');
    expect(originOf([])).toBe('MANAGED');
  });
});

describe('isProcessing (docs/03 §3.3.10)', () => {
  it('is true while any step is still pending', () => {
    expect(isProcessing(pendingSteps())).toBe(true);
    expect(isProcessing({ ...pendingSteps(), canonical: 'DONE' })).toBe(true);
  });

  it('is false once every step has settled, however it settled', () => {
    expect(
      isProcessing({
        canonical: 'DONE',
        preview: 'DONE',
        markdown: 'FAILED',
        analysis: 'SKIPPED',
        fields: 'SKIPPED',
        vectorization: 'SKIPPED',
      }),
    ).toBe(false);
  });
});

describe('pendingSteps', () => {
  it('starts every pipeline step pending (docs/05 §5.5)', () => {
    expect(pendingSteps()).toEqual({
      canonical: 'PENDING',
      preview: 'PENDING',
      markdown: 'PENDING',
      analysis: 'PENDING',
      fields: 'PENDING',
      vectorization: 'PENDING',
    });
  });
});

describe('canEditDocumentMeta (docs/03 §3.4)', () => {
  const admin = { id: 'admin-1', role: 'ADMIN' } as const;
  const alice = { id: 'user-alice', role: 'USER' } as const;
  const bob = { id: 'user-bob', role: 'USER' } as const;

  it('lets any reader tidy up a document holding a library file', () => {
    // Library content is shared property: a title nobody may correct is a title that stays wrong.
    expect(canEditDocumentMeta(alice, { createdById: null }, 'LIBRARY')).toBe(true);
    expect(canEditDocumentMeta(bob, { createdById: null }, 'LIBRARY')).toBe(true);
  });

  it('keeps a document with no library file under its creator', () => {
    const uploaded = { createdById: alice.id };

    expect(canEditDocumentMeta(alice, uploaded, 'MANAGED')).toBe(true);
    // 🔒 Bob may be able to read it through a share, but a share grants reading only.
    expect(canEditDocumentMeta(bob, uploaded, 'MANAGED')).toBe(false);
  });

  it('lets an admin edit anything', () => {
    expect(canEditDocumentMeta(admin, { createdById: alice.id }, 'MANAGED')).toBe(true);
  });
});

describe('canDestroyDocumentContent (docs/03 §3.4a)', () => {
  const admin = { id: 'admin-1', role: 'ADMIN' } as const;
  const alice = { id: 'user-alice', role: 'USER' } as const;
  const bob = { id: 'user-bob', role: 'USER' } as const;

  it('refuses every reader of a library document, its tidier included', () => {
    // 🔒 The argument for "anyone may tidy up a library document" is an argument about arranging.
    // Removing a page, replacing bytes and combining a document away all end something, and a
    // document a scan made has no creator to be asked (SEC-47).
    expect(canDestroyDocumentContent(alice, { createdById: null }, 'LIBRARY')).toBe(false);
    expect(canDestroyDocumentContent(bob, { createdById: null }, 'LIBRARY')).toBe(false);
    // Even the person who uploaded the file that made it a mixed document: it holds library bytes
    // now, and what a library holds is not one user's to destroy.
    expect(canDestroyDocumentContent(alice, { createdById: alice.id }, 'LIBRARY')).toBe(false);
  });

  it('leaves a document with no library file to its creator, exactly as editing does', () => {
    expect(canDestroyDocumentContent(alice, { createdById: alice.id }, 'MANAGED')).toBe(true);
    expect(canDestroyDocumentContent(bob, { createdById: alice.id }, 'MANAGED')).toBe(false);
  });

  it('lets an admin destroy anything, which is the rule DELETE already carries', () => {
    expect(canDestroyDocumentContent(admin, { createdById: null }, 'LIBRARY')).toBe(true);
  });
});

describe('keepsItsReaders (docs/03 §3.4a)', () => {
  it('refuses a document a scan made that would hold no library page', () => {
    // 🔒 No creator to fall back on: the document would be present in the database, absent from
    // every list and refused by every route, for everybody but an admin (SEC-60).
    expect(keepsItsReaders(null, ['MANAGED'])).toBe(false);
    expect(keepsItsReaders(null, [])).toBe(false);
    expect(keepsItsReaders(null, ['MANAGED', 'LIBRARY'])).toBe(true);
  });

  it('allows one that still has somebody: a library page, or a creator', () => {
    expect(keepsItsReaders(null, ['LIBRARY'])).toBe(true);
    expect(keepsItsReaders('user-alice', ['MANAGED'])).toBe(true);
    expect(keepsItsReaders('user-alice', [])).toBe(true);
  });
});
