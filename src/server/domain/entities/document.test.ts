import { describe, expect, it } from 'vitest';
import { isAvailable, isProcessing, pendingSteps } from './document';

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
        categorization: 'SKIPPED',
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
      categorization: 'PENDING',
      vectorization: 'PENDING',
    });
  });
});
