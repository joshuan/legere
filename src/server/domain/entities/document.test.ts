import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  canEditDocumentMeta,
  isFileReadable,
  isProcessing,
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
