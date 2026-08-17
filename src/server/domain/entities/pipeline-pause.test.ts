import { describe, expect, it } from 'vitest';
import type { DocumentStep } from '../../../shared/contracts/documents';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { DocumentSteps } from './document';
import { heldSteps } from './pipeline-pause';

// Every step where nothing has happened yet, which is what a document waiting for its first run
// looks like (docs/03 §3.3.10).
function steps(overrides: Partial<DocumentSteps> = {}): DocumentSteps {
  const pending: StepStatus = 'PENDING';
  return {
    canonical: pending,
    preview: pending,
    markdown: pending,
    analysis: pending,
    fields: pending,
    vectorization: pending,
    ...overrides,
  };
}

function held(
  paused: DocumentStep[],
  overrides: Partial<DocumentSteps> = {},
  typeId: string | null = null,
): DocumentStep[] {
  return [...heldSteps(new Set(paused), { steps: steps(overrides), typeId })].sort();
}

// What a paused step stops, and what it deliberately does not (docs/05 §5.4d).
describe('heldSteps', () => {
  it('holds nothing when nothing is paused', () => {
    expect(held([])).toEqual([]);
  });

  it('holds only the paused step where the steps beside it need nothing from it', () => {
    expect(held(['analysis'], { markdown: 'DONE' }, 'type-1')).toEqual(['analysis']);
  });

  it('holds the two steps that read the canonical when the canonical has never been built', () => {
    // Everything downstream: no PDF means no preview and no text, and no text means nothing for the
    // three steps that read it.
    expect(held(['canonical'])).toEqual([
      'analysis',
      'canonical',
      'fields',
      'markdown',
      'preview',
      'vectorization',
    ]);
  });

  it('lets the steps that read the canonical run when an earlier run built one', () => {
    expect(held(['canonical'], { canonical: 'DONE' })).toEqual(['canonical']);
  });

  it('holds the steps that read the text when the extraction has not run', () => {
    expect(held(['markdown'], { canonical: 'DONE' })).toEqual([
      'analysis',
      'fields',
      'markdown',
      'vectorization',
    ]);
  });

  it('lets the steps that read the text run when an earlier run extracted it', () => {
    expect(held(['markdown'], { canonical: 'DONE', markdown: 'DONE' })).toEqual(['markdown']);
  });

  it('leaves a failure to fail the steps that read it rather than holding them', () => {
    // 🔒 The step failed on its own account, and the steps after it settle on that fact. A pause
    // must not convert a recorded failure into a document that waits for ever.
    expect(held(['markdown'], { canonical: 'DONE', markdown: 'FAILED' })).toEqual(['markdown']);
    expect(held(['canonical'], { canonical: 'SKIPPED' })).toEqual(['canonical']);
  });

  it('holds the fields step behind a held analysis only while the document has no type', () => {
    expect(held(['analysis'], { markdown: 'DONE' })).toEqual(['analysis', 'fields']);
    // Somebody chose a type, or an earlier run read one: the fields are a reading under that type
    // and the analysis is not needed for it.
    expect(held(['analysis'], { markdown: 'DONE' }, 'type-1')).toEqual(['analysis']);
    // The analysis has already run and decided there is no type: that is a verdict, not a pause.
    expect(held(['analysis'], { markdown: 'DONE', analysis: 'DONE' })).toEqual(['analysis']);
  });
});
