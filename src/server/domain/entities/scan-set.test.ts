import { describe, expect, it } from 'vitest';
import type { ScanSetStatus } from '../../../shared/contracts/enums';
import { canEditItems, canMerge } from './scan-set';

const ALL: ScanSetStatus[] = ['DRAFT', 'QUEUED', 'PROCESSING', 'DONE', 'FAILED'];

// The scan-set state machine (docs/03 §3.3.16, docs/14 §14.8 "entity state machines").
describe('canEditItems', () => {
  it('lets a set be changed while it is DRAFT or FAILED', () => {
    expect(canEditItems({ status: 'DRAFT' })).toBe(true);
    // A failed merge is the one people actually need to fix, so it stays open.
    expect(canEditItems({ status: 'FAILED' })).toBe(true);
  });

  it('closes the set the moment a merge owns it, and keeps it closed once it succeeded', () => {
    expect(canEditItems({ status: 'QUEUED' })).toBe(false);
    expect(canEditItems({ status: 'PROCESSING' })).toBe(false);
    // 🔒 DONE is final: the result is a document in its own right from then on.
    expect(canEditItems({ status: 'DONE' })).toBe(false);
  });

  it('answers for every status the contract defines, so a new one cannot slip through as editable', () => {
    const editable = ALL.filter((status) => canEditItems({ status }));

    expect(editable).toEqual(['DRAFT', 'FAILED']);
  });
});

describe('canMerge', () => {
  it('is the same rule: a set you may still edit is a set you may still submit', () => {
    for (const status of ALL) {
      expect(canMerge({ status })).toBe(canEditItems({ status }));
    }
  });
});
