import { describe, expect, it } from 'vitest';
import { canEditDocumentMeta, isAvailable, isProcessing, pendingSteps } from './document';

describe('isAvailable (docs/03 §3.3.10)', () => {
  it('is true for a library document with at least one live ref', () => {
    expect(isAvailable({ source: 'LIBRARY' }, 1)).toBe(true);
    expect(isAvailable({ source: 'LIBRARY' }, 3)).toBe(true);
  });

  it('is false for a library document whose every copy has gone', () => {
    expect(isAvailable({ source: 'LIBRARY' }, 0)).toBe(false);
  });

  it('is always true for a derived document, whose source lives in S3 rather than the volume', () => {
    expect(isAvailable({ source: 'DERIVED' }, 0)).toBe(true);
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

  it('lets any reader tidy up a library document', () => {
    // Library content is shared property: a title nobody may correct is a title that stays wrong.
    expect(canEditDocumentMeta(alice, { source: 'LIBRARY', createdById: null })).toBe(true);
    expect(canEditDocumentMeta(bob, { source: 'LIBRARY', createdById: null })).toBe(true);
  });

  it('keeps a derived document under its creator', () => {
    const scan = { source: 'DERIVED', createdById: alice.id } as const;

    expect(canEditDocumentMeta(alice, scan)).toBe(true);
    // 🔒 Bob may be able to read it through a share, but a share grants reading only.
    expect(canEditDocumentMeta(bob, scan)).toBe(false);
  });

  it('lets an admin edit anything', () => {
    expect(canEditDocumentMeta(admin, { source: 'DERIVED', createdById: alice.id })).toBe(true);
  });
});
